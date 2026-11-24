# Approval policy per repository

A design, not yet built: a file in the repository that says, path by path, when the crew may approve a pull request and how many people must approve it too. Pure code in `packages/core` reads it and decides; the model never does.

## What exists today

- Two global switches, overridable per linked repository: `allowApprove` (off by default) and `requestChangesAt`. Next to them sit `approveBlockedAt`, `approveMaxChangedLines`, `requireVerifier` and `requireTrusted` (`packages/core/src/verdict.ts`).
- The `gate` profile turns on `requireTrusted`: an approval only when `trustLevel` says *trusted* (every lens finished, every file read, verifier ran, CI green or absent, nothing major open) (`profiles.ts`, `trust.ts`).
- A list of sensitive paths (CI, secrets, deployment, `.crewreview/`, `AGENTS.md`, `CLAUDE.md`, `CODEOWNERS`) that the attendant never changes without a person (`attend.ts`).

What's missing:

- **The settings live on each teammate's machine.** Two people running crews on the same repository can have different `allowApprove`, and nobody else can see either.
- **One rule for the whole repository.** A docs fix and a database migration get the same treatment.
- **Nothing about people.** Crewreview decides its own approval but says nothing about whether the pull request has the human approvals it needs, or whether the right people gave them.

## The file

`.crewreview/approvals.toml`, in TOML like the rest of the configuration. Crewreview reads it **from the base branch only**, at the base commit the host reports for the pull request, never from the pull request's head. A pull request can't loosen the rules it's judged by. A change to the file itself is protected (see below), so it needs a person under the old rules.

```toml
version = 1
mode = "observe"                 # "observe" or "enforce"
crewAccounts = ["acme-crew"]     # accounts Crewreview posts as; never counted as people

# Applies to files no rule matches.
[default]
crew = "optional"                # "required" | "optional" | "never"
findingsBelow = "major"          # crew approves only with no open finding at or above this
ci = "green"                     # "green" | "green-or-none"
trust = "trusted"                # "trusted" | "any"
maxChangedLines = 400            # changed lines in the whole pull request
humans = 1
from = ["@writers"]
authorCounts = false

[[rule]]
name = "docs"
paths = ["docs/**", "**/*.md"]
exclude = ["docs/security/**"]
crew = "required"
humans = 0                       # the crew's approval is enough

[[rule]]
name = "migrations"
paths = ["db/migrations/**", "**/schema.prisma"]
crew = "never"
humans = 2
from = ["@acme/dba", "alice"]

[[rule]]
name = "payments"
paths = ["services/payments/**"]
crew = "required"
trust = "trusted"
findingsBelow = "minor"
maxChangedLines = 200
humans = 1
from = ["@acme/payments"]
```

### Fields of a rule

| Field | Meaning | Default |
|---|---|---|
| `name` | Shown in the summary and the status. Unique. | required |
| `paths`, `exclude` | Globs, relative to the repository root (below). | `paths` required, `exclude` empty |
| `crew` | `required`: this rule is met only with a crew approval. `optional`: the crew may approve, but the rule doesn't wait for it. `never`: the crew never approves a pull request that touches these files. | from `[default]` |
| `findingsBelow` | The crew approves only if no open finding is at or above this severity. | `major` (today's `approveBlockedAt`) |
| `ci` | `green`, or `green-or-none` for repositories without CI. | `green` |
| `trust` | `trusted` asks for what the `gate` profile asks; `any` doesn't. | `trusted` |
| `maxChangedLines` | Above this, the crew doesn't approve. | 400 |
| `humans` | People who must approve, 0 to 10. | 1 |
| `from` | Who counts: `@writers` (anyone with write access), a login, or a team (`@org/team` on GitHub, `@group/subgroup` on GitLab). | `["@writers"]` |
| `authorCounts` | Whether the author's own approval counts. | `false` |

Fields not set in a rule come from `[default]`; fields not set there come from the table above. Unknown keys are an error, so a typo can't silently leave a rule looser than written.

### Why the author doesn't count by default

GitHub already refuses an author's approval of their own pull request; GitLab allows it unless an admin turns that off. The default matters for the other cases: a crew posting from the author's own account, a teammate's crew on a stacked branch, a GitLab project with self-approval on. With auto-merge or a merge queue, "the author counts" means a pull request can go in with one approval that is really the author saying yes to themselves, and nobody else looked. `authorCounts = true` exists for solo repositories, and the summary says it's on.

### Globs and which rule a file falls under

- Globs use `*` (inside one folder), `**` (any depth), `?` and `{a,b}`. No `!`: use `exclude`. Paths use `/`, compare byte for byte, and are case-sensitive, except for the built-in protected list (below).
- **First match wins.** Each changed file belongs to the first rule, in file order, whose `paths` match it and whose `exclude` doesn't. A file no rule matches belongs to `[default]`. We considered "most specific wins", but specificity between globs (`services/*/api/**` against `**/*.sql`) has no single answer people agree on, while order is visible in the file. `crewreview policy check` warns about a rule that an earlier one fully shadows.
- **What counts as changed:** added, modified and deleted files, a mode change, and both paths of a rename. Renaming `db/migrations/0042.sql` out of the folder still touches the migrations rule.

### How the rules combine for a pull request

A pull request usually touches several rules. All of them apply:

- **The crew approves** only if no touched rule says `never`, and the conditions of every touched rule hold. In practice the strictest of each wins: the lowest `findingsBelow`, `green` over `green-or-none`, `trusted` over `any`, the smallest `maxChangedLines`.
- **The crew's approval is needed** if any touched rule says `required`.
- **People:** each touched rule is its own requirement, met by `humans` approvals from its `from`. One approval can count for several rules if that person is in each of their `from`, the way code owner sections work. A rule with `humans = 2` and `from = ["@acme/dba"]` needs two different members of that team.
- A **change request** from someone who would count for a rule, at the current head, holds that rule until they approve or it's dismissed.

## Files that always need a person

Whatever the file says, a pull request that touches any of these gets `crew = "never"` and at least one approval from `@writers`, never the author's. A policy can ask for more (more people, named teams) but not less.

- `.crewreview/` (the policy file and the lens rubrics).
- CI: `.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`, `.gitlab/`, and the common others (`.circleci/`, `Jenkinsfile`, `azure-pipelines.yml`, `.buildkite/`).
- `CODEOWNERS` (wherever GitHub or GitLab looks for it).
- `.gitattributes` (filters and diff drivers change what a review sees) and `.gitmodules`.
- Symlinks (mode `120000`) and submodule pointers (mode `160000`): the diff shows a path or a hash, not what it points to.
- Agent configuration: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/`, `.mcp.json`, `.cursor/rules/`, `.github/copilot-instructions.md`. These are instructions to the next agent that opens the repository, the crew's own included.

These are matched case-insensitively, since a macOS or Windows checkout treats `claude.md` and `CLAUDE.md` as the same file. The list moves into one place in core (`protected.ts`); `attend.ts` keeps its own rule about what the attendant may change, built from the same list.

## Counting human approvals

Crewreview reads the approvals from the host and counts only what applies to the **current head commit**.

- **GitHub:** for each reviewer, the latest review that sets a state (`APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`; a plain comment doesn't change it). An approval counts only if its `commit_id` is the current head. This is stricter than a repository without "dismiss stale approvals", on purpose.
- **GitLab:** the approvals endpoint lists who approved but not on which commit. Crewreview takes the time of each approval from the merge request's system notes and the time of the latest push from its versions (`head_commit_sha`, `created_at`), and counts an approval only if it came after that push. Both come from the host, so every teammate gets the same answer.
- **Crew approvals** are told apart by the marker Crewreview already puts on everything it posts (`markers.ts`, extended with the head commit), and by `crewAccounts`. A crew approval is never counted as a person's, even when a crew posts from that person's own account. A forged marker only takes an approval away from its author, so it can't be used to gain one. On GitLab an approval has no body, so in `enforce` mode the crew approves there only from an account listed in `crewAccounts`; from a personal account it reports what it would do and doesn't approve.
- **Who someone is:** `@writers` means write access or above (GitHub `write`, `maintain`, `admin`; GitLab Developer or above). Team membership is read with the token the orchestrator already has. If a team can't be read (missing scope, private team), that rule stays waiting with the reason `cannot-resolve-team`. It is never treated as met.

### A new push

Every approval on an older head stops counting, the crew's included: the crew reviews the new head anyway. Later (open question), a rule could keep a human approval when none of its own files changed between the approved head and the new one, which spares a re-approval when the attendant only merged the base.

## Modes

- **`observe`** (what `policy init` writes): Crewreview works out the full decision and reports it, and changes nothing. The review summary gets a short section: which rules the change touches, whether the crew would approve and why not, and which approvals are missing ("migrations: 0 of 2 from @acme/dba"). If the commit status work lands, a `crewreview/approvals` status carries the same thing and is always `success` in this mode, so requiring it early can't block anyone. The policy never makes the crew approve; the crew's own verdict follows today's settings, unchanged.
- **`enforce`:** the crew posts an approval only when the policy allows it, and `crewreview/approvals` is `pending` until every rule is met, `success` when it is, `failure` when the policy can't be read. Today's local `allowApprove = false` stays a veto: a teammate can always refuse to have their account approve. Local settings can make things stricter, never looser.

**No file:** exactly today's behavior, and no approvals status.

**A file that can't be read** (bad TOML, unknown key, a limit passed, an unknown `version`): the crew doesn't approve, the summary says why, and the status is `failure` with `policy-invalid`. It fails closed. Falling back to the global settings would mean a typo turns the policy off.

## What Crewreview can and can't enforce

It can withhold its own approval, and it can set a status. That's all. Merging is the host's job: the policy only binds if branch protection (GitHub) or a required external status check (GitLab) requires `crewreview/approvals`, and the docs will say that in the first paragraph. Without that, a person with merge rights can merge anyway, and should be able to. Crewreview also doesn't replace CODEOWNERS or GitLab approval rules; it can sit next to them, and the summary says where they overlap.

## Several crews, one answer

Crewreview is local-first: several teammates may run crews on the same repository. They have to agree without talking to each other.

- **Same file:** everyone reads the policy at the base commit the host reports, not their own mirror's tip.
- **Same inputs:** the status is a pure function of what the host shows: the policy, the changed files and their modes, CI, the approvals and their markers, team membership. A crew's own findings don't go into the status directly. They go in through the approval that crew posts, or doesn't. The crew part of a rule is met when some crew approved the current head and no crew asked for changes on it.
- **Same output:** the input lists are sorted before the decision, so order doesn't matter, and a test proves it.
- **Dedupe:** a crew writes the status only if its state or description would change. The description holds the decider's version and a short hash of the policy (`v1 · 3f2a9c · 1 of 2 approvals`). A crew running an older decider doesn't overwrite a status a newer one wrote.

## Limits

- File: at most 64 KiB, 200 rules, 50 globs per `paths` or `exclude`, 256 characters per glob, 100 entries per `from`, `humans` from 0 to 10.
- Pull request: if the host can't list every changed file (GitHub's file list stops at 3000), the decision can't be made and it fails closed.
- Globs are matched by a small matcher in core with no backtracking, so a hostile pattern can't make it slow.

## In code

`packages/core/src/approvals.ts`, all pure:

- `parseApprovalsPolicy(text): Policy | PolicyError`: TOML, the schema, limits, defaults filled in.
- `protectedFiles(changes)` and `ruleFor(path, policy)`.
- `decideApprovals(input): ApprovalsDecision`, from the policy, the changes, the review (findings, trust, CI, size), the approvals with their commit and author, the team members, and the author. It returns whether the crew may approve, whether its approval is needed, each rule's state with its reasons, and the status. `decideVerdict` stays as it is; in `enforce` mode the engine passes it an `allowApprove` and thresholds taken from this decision.

The engine reads the file from the mirror at the base commit, fetches approvals and teams through `packages/hosts`, and posts. New CLI: `crewreview policy init` (writes a file from today's settings, in `observe`), `policy check` (validates and warns about shadowed rules) and `policy explain <pr>` (the decision, rule by rule). Every string is translated.

## Moving from today's settings

`policy init` writes `[default]` from what the repository uses now: `allowApprove = false` becomes `crew = "never"`, otherwise `optional`; `approveBlockedAt` becomes `findingsBelow`; `approveMaxChangedLines` becomes `maxChangedLines`; `requireTrusted` or the `gate` profile becomes `trust = "trusted"`. It adds `humans = 1`, `from = ["@writers"]` and `mode = "observe"`, and you commit it through a pull request like any change. `requestChangesAt` stays a review setting: it's about the crew's own verdict, not about approvals.

## Rollout

1. **Core:** parser, matcher, protected list, decider, tests. Nothing uses them yet.
2. **Observe:** the summary section and `policy explain`; the status too if commit statuses have landed. Tried on this repository and a sandbox for a while, comparing what it says with what people did.
3. **Enforce the crew's approval:** `mode = "enforce"` controls what the crew posts.
4. **Enforce the status:** `pending` and `failure` for real, with a guide to requiring it in branch protection, checked live on GitHub and GitLab.
5. **Later, a risk classifier** (below).

## Later: a risk classifier

A model reads the change (fenced, untrusted) and proposes a risk level with reasons. Code maps the level to changes that can **only make the policy stricter**: `high` turns the crew to `never` for this pull request and adds one approval; `critical` also asks for a named team the policy sets. `low` relaxes nothing. A pull request that talks the model into "low" gains nothing; one that talks it into "critical" only costs itself a person's look, and the summary shows the level and why. The classifier never sees or changes the policy file.

## Tests

- **Matching:** first match, `exclude`, `**` at either end, braces, renames out of a rule's folder, deletions, mode-only changes, shadowed-rule warnings.
- **Protected files:** a property test with random policies: none of them lets the crew approve a change to `.crewreview/approvals.toml`, a workflow, a symlink or a submodule, or lets it through with zero people. Case variants of `CLAUDE.md`.
- **Combining:** strictest conditions win; one approver counts for several rules; two different members for `humans = 2`.
- **Counting:** recorded GitHub reviews (stale `commit_id`, dismissed, changes requested then approved) and GitLab approvals, notes and versions (approval before and after the last push), in the hosts contract tests.
- **Author and crew:** author never counted unless `authorCounts`; a crew approval from a personal account never counted as that person.
- **Failing closed:** bad TOML, unknown keys, every limit, unreadable team, truncated file list.
- **Determinism:** shuffled inputs give the same decision; `observe` never yields an approval or a non-`success` status.
- **Live:** a sandbox repository with branch protection requiring `crewreview/approvals`, two crews on two machines, each step of the rollout.

## Open questions

1. **Keep approvals across a push** when a rule's own files didn't change, or always drop them (the simple, strict default proposed here)?
2. **The last person to push:** should someone who pushed commits to the pull request count as a reviewer for it, the way GitHub's "approval of the most recent push" rule asks? It needs a reliable way to map commits to accounts.
3. **The protected list:** is it right, and should a change that only sets the executable bit be on it?
4. **Observe and today's approvals:** should `observe` also hold back approvals today's settings would post, or leave them alone as proposed?
5. **Overlap with CODEOWNERS and GitLab approval rules:** only report it, or offer to read CODEOWNERS as a starting `from`?
6. **GitLab from a personal account:** is refusing to approve in `enforce` mode too strict for small teams without a bot account?
