<div align="center">

# Crewreview

**A crew of AI agents that reviews your pull requests and answers the reviews on yours.**

Runs on your machine, with the coding agents you already use: Claude Code, Codex, Kiro, any [ACP](https://agentclientprotocol.com) agent, or any CLI you describe.

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Status](https://img.shields.io/badge/status-pre--alpha-orange)
![Platforms](https://img.shields.io/badge/macOS%20·%20Linux%20·%20Windows-lightgrey)

</div>

> **Status: pre-alpha.** Local review works today (`crewreview local`). Pull request review, the attendant that fixes and answers review comments, the dashboard and the desktop app are being built; see the [roadmap](docs/ROADMAP.md).

## What it does

- **Reviewer.** Several read-only lenses look at a change in parallel: correctness, security, architecture, tests and UI. A verifier then tries to refute each finding, and a fixed rule (not a model) decides the verdict. Findings that don't point at a real `file:line` are dropped.
- **Attendant** *(coming in v0.1)*. On your own pull requests, it reads new review comments, fixes what it should in an isolated worktree, replies, resolves the thread and asks for a re-review. The agent never holds your git host token: Crewreview does the posting.
- **Crew view** *(coming in v0.1)*. A dashboard to watch every agent live, approve what waits in the inbox, link repositories and switch automations on or off, and see limits and costs.

Everything runs locally. No server, no account, no telemetry.

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

Binaries for macOS, Linux and Windows will come with the first release.

## Harnesses

| Harness | How it runs | Read-only lock |
|---|---|---|
| Claude Code | `claude -p`, stream-json, tools limited to Read/Grep/Glob, user hooks and plugins off | flags + conformance test |
| Codex CLI | `codex exec --json -s read-only`, user config ignored | sandbox + conformance test |
| Kiro CLI | `kiro-cli chat --no-interactive`, only read tools trusted | flags + conformance test |
| Any ACP agent | Agent Client Protocol over stdio; Crewreview answers every permission request | enforced by Crewreview, must pass conformance |
| Custom | Any CLI described in your config | must pass conformance |

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

[limits]
maxConcurrentAgents = 3
agentTimeout = "20m"
maxDiffLines = 4000

[review]
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
