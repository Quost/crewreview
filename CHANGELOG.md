# Changelog

Notable changes to Crewreview. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## Unreleased

## 0.5.0 — 2026-11-20

Easier to start, alone or as a team: a first-run setup, and a Docker image for a shared team machine.

### Added

- A first-run setup in the dashboard and the desktop app. While nothing is linked it opens by itself and goes through the agents and their login, access to GitHub or GitLab (and as whom), a preview of what a repository or organization would start, and linking it in inbox mode. Later it's one click away, under Repositories.
- A Docker image for a shared team machine, where one bot account reviews the team's pull requests ([guide](docs/team-machine.md)). It installs the release binary only after checking its signature, comes with Claude Code and Codex, keeps the config, history and agent logins in one volume, and the dashboard is reached over SSH.
- The local API answers `GET /api/hosts` (which git hosts this machine can reach, and as whom) and `POST /api/preview` (what an address that isn't linked yet would start).

## 0.4.0 — 2026-11-20

For teams: link a whole organization, limits that act on their own, and an attendant that fixes conflicts and red CI.

### Added

- The attendant can fix a conflict with the base and a red CI on your own pull requests (`--conflicts on`, `--ci on`, or the switches in the dashboard). A conflict is merged, never rebased: the base is merged in the work tree, the agent resolves the markers, and the merge commit is pushed as a fast-forward; a conflict it can't fully resolve is undone and left to you. For red CI the agent gets the failing jobs' logs, with secrets taken out. Both run your checks before anything is pushed.
- "What would run now": `crewreview repo preview <id or url>` and a button on each repository in the dashboard show which pull requests a cycle would review, what it would skip and why, and about how many agent runs it would take against today's budget, without reviewing, posting or recording anything. It works for an organization, and for an address you haven't linked yet.
- Limits that act. A harness that hits its usage limit is paused until the time its message gives ("resets 3pm", "try again in 2 hours"; an hour when it doesn't say) and resumes by itself; meanwhile `harness.fallback` (or, with `auto`, the other installed harnesses) takes over. `limits.dailyRuns` caps the agent runs of a day. The dashboard shows paused harnesses and today's runs.
- The computer stays awake while agents work, so a review or an answer isn't cut off by sleep; the screen still turns off as usual. It uses `caffeinate` on macOS, `systemd-inhibit` on Linux and the system's own request on Windows, tied to the daemon's process. Turn it off with `keepAwake = false` in `[schedule]`.
- Link a whole GitHub organization or GitLab group: `crewreview repo add https://github.com/acme`, or the same address in the dashboard. Every repository in it is watched with the organization's settings, new ones too and archived ones never; `--include` and `--exclude` filter by name. One search per cycle finds the repositories with open pull requests. A repository linked on its own keeps its own settings.
- `doctor` shows whether each harness is signed in, here and as the background service would see it, with when Claude Code's login expires and the command that signs it in. The dashboard shows it too.
- The crew checks a harness's login before it starts a job: a signed-out harness is reported once per pull request with the command to fix it, instead of failing every run.

### Changed

- The background service keeps `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, so it uses the same Claude Code and Codex login as the terminal it was installed from. Run `crewreview service install` again to pick this up.
- The dashboard shows the built-in lenses' names in your language, and code in findings and replies as code.

### Fixed

- Counts read naturally in every language: no more "1 replies", "1 revisados" or "0 achado".

## 0.3.0 — 2026-11-19

The desktop app, and a simpler way to install.

### Added

- The desktop app for macOS, Windows and Linux: the dashboard in its own window, the inbox count in the menu bar or tray, a notification when a review or an answer waits for your approval, check now, open at login, and signed updates. It runs the crew it bundles, or shows the one already running as a service. A notarized `.dmg` for macOS (Apple silicon and Intel), an installer for Windows, and an AppImage, `.deb` and `.rpm` for Linux (x64 and arm64).
- `crewreview run --desktop`, how the desktop app runs the crew (documented in `apps/desktop/README.md`).

### Changed

- Release signatures name their file and version in the trusted comment (`timestamp:…`, `file:…`, `version:…`), the format the desktop app's updater checks. `SHA256SUMS` also lists the desktop installers.
- `crewreview update` refuses to replace the copy inside the desktop app, which updates it itself.
- The website's install section: one download button for your system and processor, three short ways to install (the app, one terminal line, Homebrew or Scoop), and a prompt you paste into any AI agent so it installs and sets up Crewreview for you.

## 0.2.0 — 2026-11-19

The public launch: notarized macOS binaries, one-line installers, Homebrew and Scoop, a Claude Code plugin and an MCP server for coding agents, and the website.

### Added

- `crewreview mcp`: a Model Context Protocol server, so coding agents can check a branch with Crewreview, see what it watches, read the inbox, link repositories and explain settings. It never approves, posts or pushes. `crewreview mcp setup` shows how to add it to Claude Code, Codex, Gemini CLI, Kiro, Cursor and OpenCode.
- A Claude Code plugin and marketplace in this repository (`/plugin marketplace add Quost/crewreview`): the MCP server, a skill that teaches agents when and how to use Crewreview, and the `/crewreview` command.
- One-line installers (`install.sh`, `install.ps1`) that check the checksum and, with minisign, the signature; a Homebrew formula and a Scoop manifest in this repository, updated by each release.
- The release workflow signs and notarizes the macOS binaries with a Developer ID when `MACOS_SIGNING` is on.
- The website, in five languages, built from `site/` with `bun run site`, with a sponsor section.
- Sponsor links (GitHub Sponsors, Buy Me a Coffee) in `.github/FUNDING.yml`.

## 0.1.0 — 2026-11-19

The first release: a crew of AI agents that reviews pull requests and answers the reviews on yours, locally, with the harnesses you already use.

### Added

- `crewreview local`: reviews the current branch against its base with parallel read-only lenses (correctness, security, architecture, tests, UI), checks every finding points at a real file and line, merges duplicates, runs a verifier that can confirm, downgrade or drop findings, and decides the verdict with a fixed rule.
- Harness adapters for Claude Code, Codex CLI and Kiro CLI, a generic Agent Client Protocol client, and custom CLIs described in config.
- `crewreview doctor`, with `--conformance` to prove each harness's read-only lock with a real run.
- Repository lenses in `.crewreview/lenses/`.
- Interface in English, Brazilian Portuguese, Spanish, German and Simplified Chinese.
- Pull request review on GitHub and GitLab (cloud and self-managed): `crewreview repo add|list|set|remove`, `review <repo> <number>`, `inbox [show|approve|discard]`, `once` and `run`.
- New repositories start in inbox mode: reviews wait for your approval before they're posted; `--mode auto` posts right away.
- Reviews skip drafts, bots, skip labels, commits already reviewed (also detected from Crewreview's own markers on the host) and pushes that only merged the base; they wait for pushes to settle and for CI.
- Each review reads the description, the discussion so far, CI and the changes since the last review, never repeats a point already made, and posts inline comments where the diff allows, the rest in the summary.
- An inbox review whose pull request got new commits is refused as stale instead of describing old code.
- The attendant (`crewreview attend`, `[repo.attend]`, `--attend off|inbox|auto`): answers review comments on your own pull requests by fixing, replying, declining or leaving it to you, in a worktree of Crewreview's mirror; commits with your identity, pushes without force, replies, resolves fixed threads and asks for a re-review. Only people with write access steer it. Optional checks run before pushing, with one retry. Sensitive files always wait for approval.
- The polish loop (`--polish on`): the attendant also takes the findings Crewreview's reviewer left on your pull request, for up to `maxPolishRounds` rounds.
- `doctor --conformance` also proves each harness writes only inside its working folder; the attendant refuses harnesses that didn't pass.
- The dashboard (`crewreview ui`, served by `crewreview run`): agents at work live, the activity log, the inbox with approve and discard, history, repositories with review and attendant switches, harnesses and limits with today's usage. Light and dark, phone width, five languages.
- A local API on 127.0.0.1 with a per-start token, Host checks and a live event stream.
- `crewreview service install|uninstall|status`: launchd on macOS, systemd --user on Linux, a logon task on Windows.
- `crewreview update`: installs the newest release only after checking the minisign signature of SHA256SUMS and the binary's checksum; the daemon checks daily and can install by itself.
- `crewreview attend --retry` gives given-up items another chance; login and quota failures no longer use up attempts.
