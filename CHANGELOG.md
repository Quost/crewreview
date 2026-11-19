# Changelog

Notable changes to Crewreview. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## Unreleased

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
