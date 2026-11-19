# Changelog

Notable changes to Crewreview. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Added

- `crewreview local`: reviews the current branch against its base with parallel read-only lenses (correctness, security, architecture, tests, UI), checks every finding points at a real file and line, merges duplicates, runs a verifier that can confirm, downgrade or drop findings, and decides the verdict with a fixed rule.
- Harness adapters for Claude Code, Codex CLI and Kiro CLI, a generic Agent Client Protocol client, and custom CLIs described in config.
- `crewreview doctor`, with `--conformance` to prove each harness's read-only lock with a real run.
- Repository lenses in `.crewreview/lenses/`.
- Interface in English, Brazilian Portuguese, Spanish, German and Simplified Chinese.
