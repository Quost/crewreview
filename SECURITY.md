# Security

## Reporting a vulnerability

Please report it privately through [GitHub's private vulnerability reporting](https://github.com/Quost/crewreview/security/advisories/new), not in a public issue. You'll get an answer within a week. Include what you found, how to reproduce it, and what an attacker could do with it.

## Threat model

Crewreview runs AI agents on code written by other people and on text anyone can type into a pull request. It is built around four assumptions:

1. **Pull request content is hostile.** Descriptions, comments, commit messages, code comments, docs and CI logs may contain instructions aimed at the agents.
2. **Agents can be talked into things.** A prompt is not a security boundary.
3. **The harness's own lock is the boundary.** Read-only roles rely on the harness refusing writes and shell, and Crewreview checks that on every machine.
4. **Your git host token is the crown jewel.** Whoever holds it can push, approve and merge as you.

What follows from them:

| Risk | What Crewreview does |
|---|---|
| Prompt injection from PR content | Untrusted text goes into prompts fenced with a random nonce, and every prompt says not to follow instructions found in the data. Agents only produce proposals; code decides the verdict and what gets posted. |
| A reviewer agent changing files or running commands | Reviewer lenses and the verifier run read-only: tools limited by flags, a sandbox where the harness has one, and Crewreview answering every ACP permission request. A deny-list test rejects any command line with `--dangerously-*`, `--yolo`, `--trust-all-tools`, `danger-full-access` and similar. `crewreview doctor --conformance` proves the lock with a canary on your machine, per harness version. ACP and custom harnesses must pass it before they can review. |
| Agents reaching your credentials | Agents get a filtered environment: git host tokens (`GH_*`, `GITHUB_*`, `GITLAB_*`…), cloud credentials, `SSH_AUTH_SOCK` and anything that looks like a secret are removed. Only the variables a harness needs for its own login pass through. |
| A pull request rewriting the rules it is judged by | For pull requests, project guidelines and `.crewreview/lenses/` are read from the base branch, never from the head. |
| Your files being touched | Agents work on an exported copy of the tree in Crewreview's own folder, made with a throwaway git index: your work tree, index, HEAD and worktree list stay as they are. |
| Secrets in logs going to a model | CI logs and commit messages go through a redaction pass for common token formats. It's a safety net, not a scanner. |
| The attendant being steered by a stranger | Only comments from accounts with write access to the repository (checked with the host), bots you list, and, with the polish loop, Crewreview's own findings become work for the agent. Everyone else is ignored. |
| The attendant writing outside its worktree | Its harness must pass a write-scope canary on your machine (a file inside the folder appears, one outside doesn't) for its exact version. Codex runs with `/tmp`, `$TMPDIR` and network closed. |
| A fix sneaking in a workflow, a secret or a rule change | Changes to CI configuration, secret files, deployment folders, `CODEOWNERS`, `AGENTS.md`/`CLAUDE.md` or `.crewreview/` always wait for your approval, even in auto mode. |
| An agent pushing or force-pushing | The agent never gets the token. Crewreview commits with your identity and signing settings and pushes without force; a moved branch makes the answer stale instead of overwriting anything. |
| Hooks and plugins from your harness setup running inside a review | Claude Code runs with `--safe-mode`, `--restricted` and `--strict-mcp-config`; Codex with `--ignore-user-config --ignore-rules`; Kiro never gets `--trust-workspace`. |

### Out of scope

- A harness that ignores its own flags or sandbox. Report that to its vendor; `doctor --conformance` is there to catch it.
- What a model provider does with the code you send it. Choosing a harness is choosing where your code goes.
- Attacks that need write access to your machine or your Crewreview config.

## Supported versions

Until 1.0, only the latest release gets security fixes.
