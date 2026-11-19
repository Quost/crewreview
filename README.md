<div align="center">

# Crewreview

**A crew of AI agents that reviews your pull requests and answers the reviews on yours.**

Runs on your machine, with the coding agents you already use: Claude Code, Codex, Kiro, any [ACP](https://agentclientprotocol.com) agent, or any CLI you describe.

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Status](https://img.shields.io/badge/status-pre--alpha-orange)
![Platforms](https://img.shields.io/badge/macOS%20·%20Linux%20·%20Windows-lightgrey)

</div>

> **Status: pre-alpha.** Local review, pull request review, the attendant that answers the reviews on your own pull requests, the dashboard, the background service and signed updates work today, on GitHub and GitLab. The desktop app and the website come next; see the [roadmap](docs/ROADMAP.md).

## What it does

- **Reviewer.** Several read-only lenses look at a change in parallel: correctness, security, architecture, tests and UI. A verifier then tries to refute each finding, and a fixed rule (not a model) decides the verdict. Findings that don't point at a real `file:line` are dropped.
- **Attendant.** On your own pull requests, it reads new review comments, fixes what it should in an isolated worktree, replies, resolves the thread and asks for a re-review. The agent never holds your git host token: Crewreview does the committing, pushing and posting.
- **Crew view.** A dashboard to watch every agent live, approve what waits in the inbox, link repositories and switch automations on or off, and see limits and costs.

Everything runs locally. No server, no account, no telemetry.

## Install

```bash
curl -fsSL https://crewreview.web.app/install.sh | sh          # macOS, Linux
brew install Quost/crewreview/crewreview                       # or Homebrew
irm https://crewreview.web.app/install.ps1 | iex               # Windows (or: scoop bucket add crewreview https://github.com/Quost/crewreview; scoop install crewreview)
```

The installers check the binary against the release's `SHA256SUMS`, and its signature too when `minisign` is installed. Builds are reproducible: the same commit and Bun version give the same bytes.

## Try it

You need [Bun](https://bun.sh) 1.3+, git, and at least one harness: [Claude Code](https://claude.com/claude-code), [Codex CLI](https://github.com/openai/codex) or [Kiro CLI](https://kiro.dev).

```bash
git clone https://github.com/Quost/crewreview
cd crewreview
bun install
bun run dev doctor                 # what's installed and what each harness can do
bun run dev doctor --conformance   # prove the read-only lock with a real run (two tiny prompts each)
```

Then, inside any git repository, on a branch:

```bash
bun /path/to/crewreview/apps/cli/src/main.ts local
```

Useful options: `--base origin/develop`, `--uncommitted`, `--harness codex`, `--verifier-harness claude` (a second vendor checks the first), `--lens security`, `--lang pt-BR`, `--json`.

Or download a binary from [Releases](https://github.com/Quost/crewreview/releases) (macOS, Linux and Windows). Each release's `SHA256SUMS` is signed with the [release key](docs/release-key.pub):

```bash
minisign -Vm SHA256SUMS -P RWTk8l0TkAFZQOxVkYWEHrU6Nj+j1UTCGOMps627c4qsvaX3fvRFzhpx
shasum -a 256 -c SHA256SUMS --ignore-missing
```

The binaries aren't notarized or code-signed yet (that comes with the desktop app), so macOS and Windows may warn the first time you open one.

### Review pull requests

Link a repository. Crewreview uses the login you already have in `gh` or `glab` (or `GH_TOKEN` / `GITLAB_TOKEN`):

```bash
crewreview repo add https://github.com/acme/shop            # new repositories start in inbox mode
crewreview repo add https://gitlab.com/acme/api --mode auto  # or post reviews right away
crewreview review acme-shop 42                               # review one pull request now
crewreview inbox                                             # what's waiting for you
crewreview inbox approve 3                                   # post it
crewreview run                                               # keep watching every linked repository
```

What it does for each pull request:

- Skips drafts, bots, your own pull requests (`--authors all` reviews them too), a `no-ai-review` label, commits it already reviewed, and pushes that only merged the base branch.
- Waits a few minutes for a series of pushes to settle, and for CI to finish.
- Fetches into its own mirror (your clones are never touched), reads the project rules from the base branch, the description, the discussion so far, CI, and what changed since its last review.
- Posts one review: inline comments on lines the diff shows, everything else in the summary. Hidden markers let it recognize its own comments later; points already made in the discussion aren't repeated.
- An approval needs `allowApprove = true`, no serious findings, green CI and a change under the size limit. On your own pull requests it only comments.

### Answer the reviews on your pull requests

```bash
crewreview repo set acme-shop --attend inbox      # or auto; off by default
crewreview attend acme-shop 42 --dry-run          # see what it would do, nothing saved or pushed
crewreview attend acme-shop 42                    # fix and draft the replies, wait in the inbox
crewreview inbox show f3                          # decisions, replies, diff, checks
crewreview inbox approve f3                       # push, reply, resolve, ask for a re-review
```

- Only comments from people who can push to the repository (and bots you list, like Copilot) steer the agent.
- It waits until a review stops arriving, then works in a worktree of Crewreview's mirror, never in your clone.
- For each comment it decides: fixed, replied, declined, or needs you. "Fixed" with nothing changed counts as needs you.
- `validate = ["bun install", "bun test"]` in `[repo.attend]` runs your checks before anything is pushed; if they fail, the agent gets one more try, then it waits for you.
- Changes to CI, secrets, deployment files or the crew's own rules always wait for your approval, even in auto mode.
- Commits use your git identity and signing settings, and say `Assisted-by: Crewreview`. Pushes never force; if the branch moved, the answer is redone.
- Replies say they were answered by Crewreview.
- `--polish on` also takes the findings Crewreview's reviewer left on your pull request: review, fix, review again, for up to `maxPolishRounds` (3) rounds.

The attendant edits files, so its harness must prove on your machine that it can write in its worktree and can't write outside it: run `crewreview doctor --conformance` once per harness version.

### Dashboard, service and updates

```bash
crewreview ui                  # open the dashboard (starts the daemon if it isn't running)
crewreview service install     # start the daemon with your login: launchd, systemd --user or a logon task
crewreview service status
crewreview update              # install the newest signed release; --check only looks
```

- The dashboard is served by the daemon on `127.0.0.1` only. Each start makes a new key, which the browser gets in the link's `#fragment`, so it never reaches a log. Pages: **Now** (agents at work, live, and the activity log), **Inbox** (approve or discard, with findings, replies and diffs), **History**, **Repositories** (switch review and the attendant off, inbox or auto) and **Harnesses & limits**.
- A service runs without your terminal's environment. Make sure each harness is signed in for unattended use (for Claude Code, `claude setup-token`; Codex and Kiro keep their own login), and that `gh`/`glab` are signed in. On Linux, `loginctl enable-linger $USER` keeps it running after you log out.
- `update` installs a release only when its `SHA256SUMS` carries a valid signature from the release key built into your binary, and the binary matches its checksum. With `[updates] auto = true` the daemon installs new releases when idle and restarts through the service manager.

### Let your coding agent use it

```bash
crewreview mcp setup          # prints how to add the MCP server to Claude Code, Codex, Gemini CLI, Kiro, Cursor, OpenCode
claude mcp add --scope user crewreview -- crewreview mcp
```

The agent can then review your branch before committing, check what the crew is doing, read the inbox, link a repository or explain a setting, when you ask. It can't approve, post or push: that stays with you.

In Claude Code, the plugin brings the MCP server, a skill and the `/crewreview` command:

```text
/plugin marketplace add Quost/crewreview
/plugin install crewreview@crewreview
```

For other agents, the skill is in [`plugins/crewreview/skills/crewreview/SKILL.md`](plugins/crewreview/skills/crewreview/SKILL.md).

## Harnesses

| Harness | How it runs | Read-only lock |
|---|---|---|
| Claude Code | `claude -p`, stream-json, tools limited to Read/Grep/Glob, user hooks and plugins off | flags + conformance test |
| Codex CLI | `codex exec --json -s read-only`, user config ignored | sandbox + conformance test |
| Kiro CLI | `kiro-cli chat --no-interactive`, only read tools trusted | flags + conformance test |
| Any ACP agent | Agent Client Protocol over stdio; Crewreview answers every permission request | enforced by Crewreview, must pass conformance |
| Custom | Any CLI described in your config | must pass conformance |

Write scope for the attendant, tested on 2026-11-19: Claude Code and Codex (with `/tmp` and `$TMPDIR` closed) pass; Kiro CLI's `fs_write` wrote outside its folder, so Kiro can review but not attend.

Flags that switch a harness's safety off (`--dangerously-*`, `--yolo`, `--trust-all-tools`, `danger-full-access`…) are refused by a test on every command line Crewreview builds.

## Configuration

Optional. `~/.config/crewreview/config.toml` (Windows: `%APPDATA%\Crewreview\config.toml`):

```toml
language = "pt-BR"            # interface language

[harness]
default = "claude"            # or auto, codex, kiro, an ACP agent, a custom one
verifier = "codex"            # a different vendor makes a stronger check

[harness.claude]
model = "opus"

[[harness.acp]]
id = "gemini"
command = ["gemini", "--experimental-acp"]

[schedule]
interval = "3m"               # how often `crewreview run` checks, during peak hours
offHoursInterval = "20m"
peakHours = "8-19"
maxReviewsPerCycle = 2

[updates]
check = true                  # look for a new release once a day
auto = false                  # install it when idle and restart
channel = "stable"            # or "beta"

[limits]
maxConcurrentAgents = 3
agentTimeout = "20m"
maxDiffLines = 4000

[review]
settle = "3m"                 # wait after a new push
ciMaxWait = "45m"             # wait for running CI up to this long
lenses = ["correctness", "security", "architecture", "tests", "ui"]
commentLanguage = "en"        # language the agents write findings in

[review.policy]
requestChangesAt = "blocker"
allowApprove = false
```

A repository can tune its own review in `.crewreview/lenses/<lens>.md`: a file named like a built-in lens replaces its rubric, and any other file adds a lens.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Every commit needs a `Signed-off-by` line ([DCO](https://developercertificate.org)).

## License

Crewreview is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a service for others, you must share its source. The name and logo are covered by [TRADEMARK.md](TRADEMARK.md).
