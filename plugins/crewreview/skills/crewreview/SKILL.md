---
name: crewreview
description: Use Crewreview, a local crew of AI agents that reviews pull requests and answers the reviews on the user's own. Use when the user wants a review of their branch before committing or opening a pull request, wants to set up automatic reviews or review answers on GitHub or GitLab, asks what Crewreview is doing, or wants to change its settings.
---

# Crewreview

Crewreview runs on the user's machine. It reviews changes with several read-only "lenses" (correctness, contracts, security, architecture, tests, UI) in parallel, checks each finding against the real code, lets a verifier try to refute them, and decides the verdict with a fixed rule. On the user's own pull requests, an "attendant" can fix, reply to and resolve review comments. It uses the coding agents already installed (Claude Code, Codex, Kiro, ACP agents).

Prefer the MCP tools when the `crewreview` MCP server is connected (`crewreview_status`, `crewreview_review_local`, `crewreview_inbox`, `crewreview_inbox_item`, `crewreview_repo_link`, `crewreview_repo_set`, `crewreview_harnesses`, `crewreview_config`). Otherwise use the CLI.

## Review before committing

1. Make sure the work is on a branch with a base (`origin/main` or similar).
2. Run `crewreview local` (add `--uncommitted` for changes not committed yet, `--lens security` for one lens, `--lang pt-BR` for findings in another language). It takes a few minutes and posts nothing.
3. Read the verdict and the findings. Each has a file, a line, a severity (blocker, major, minor, nit) and a body. Fix blockers and majors first; check each claim in the code before acting on it.

## Set up

- `crewreview doctor` shows installed harnesses. `crewreview doctor --conformance` proves each one's read-only lock (and write scope, for the attendant) with a real run; it uses a little quota.
- `crewreview repo add <url>` links a repository. Reviews start in **inbox** mode: nothing is posted until the user approves. `--mode auto` posts directly; `--attend inbox|auto` turns on the attendant for the user's own pull requests; `--polish on` also fixes Crewreview's own findings.
- `crewreview service install` starts the daemon with the user's login; `crewreview ui` opens the dashboard.
- Settings: `crewreview_config` (or `~/.config/crewreview/config.toml` and `repos.toml`). Lens rubrics can be replaced or added per repository in `.crewreview/lenses/<lens>.md`.

## Rules

- Change repository modes, link repositories or switch anything to `auto` only when the user asked for it.
- Never approve, post or push for the user. Approval happens in the dashboard or with `crewreview inbox approve <id>`, by the user.
- Don't edit `.crewreview/` or `AGENTS.md` in a repository to make a review pass.
