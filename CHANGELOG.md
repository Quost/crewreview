# Changelog

Notable changes to Crewreview. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## Unreleased

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
