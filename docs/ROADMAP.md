# Roadmap

Crewreview is a crew of AI agents for pull requests: reviewers that look at other people's changes, and an attendant that answers the reviews on yours. It runs locally, on macOS, Linux and Windows, with the harnesses you already use.

## Milestones

| | What ships | Done when |
|---|---|---|
| **M0** ✅ | Repository, license, CI on three systems, release pipeline, translations | CI is green everywhere; the binary builds for five targets |
| **M1** ✅ | Pure review rules, harness adapters (Claude Code, Codex, Kiro, ACP, custom), `doctor` with a real conformance test, `crewreview local` | A local review of a real branch runs with two different harnesses; the canary proves the read-only lock |
| **M2** 🟡 | GitHub and GitLab adapters, linked repositories, a mirror and a worktree per job, state in SQLite, the reviewer as a daemon, an inbox for approvals, posting reviews | Pull requests on test repositories are reviewed on both hosts, in inbox mode and automatically (GitHub verified live; GitLab covered by contract tests, live check pending) |
| **M3** 🟡 | The attendant: pending items, debounce, safe write mode, validation, signed commits, push, replies, resolved threads, re-review requests, loop guard | A seeded review is fixed and answered on both hosts (GitHub verified live; GitLab by contract tests, live check pending). Conflicts and red CI as attendant items come next |
| **M4** | Dashboard (live agents, inbox, history, repositories, limits), `service install` on three systems, `update` → **v0.1** | Automations switch on and off from the UI; the daemon starts with the system; updates replace the binary after checking it |
| **M5** | Desktop app (Tauri: tray, auto-update, installers, signed builds), the website in five languages → **v0.2** | Installs and updates itself on three systems |
| **M6** | Bitbucket (Cloud and Data Center), Azure DevOps, Gitea/Forgejo; more harnesses (OpenCode, Pi, Gemini, Cursor, Copilot, Antigravity); a terminal UI; an MCP server; webhooks; a Docker image for teams | Every host adapter passes the same contract suite |
| **M7** | Mobile companion: pairing by QR code, LAN or Tailscale access, push notifications, the inbox on your phone | A fix is approved from the phone and lands on the pull request |

## Ideas on the list

- **Polish loop.** On your own pull request: review, fix, review again, until it's clean, before asking a human.
- **Pre-push hook.** A local review that runs before you push, with no host and no token.
- **Council.** A verifier from a different vendor than the reviewers.
- **Memory of dismissals.** A finding the team declined doesn't come back on that repository.
- **Acceptance rate.** How many findings led to a change, as the honest measure of review quality.
- **Rubric packs.** Shareable lenses for security, accessibility, specific languages and frameworks.
- **Notifications.** Native, ntfy, Slack, Discord.

## Principles

- The model proposes; code decides.
- Agents never hold your git host token.
- Read-only means read-only, and it's proven on your machine.
- Nothing leaves your machine except what goes to the harness you picked.
- Everything a user sees is translated.
