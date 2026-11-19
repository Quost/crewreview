# Roadmap

Crewreview starts as a crew of AI agents for pull requests: reviewers that look at other people's changes, and an attendant that answers the reviews on yours. It runs locally, on macOS, Linux and Windows, with the harnesses you already use. Where it's going: give it a task, and the crew builds it, reviews it, answers the reviews and hands you a pull request that's ready for a human.

## Shipped

| | What | Status |
|---|---|---|
| **M0** ✅ | Repository, AGPL-3.0, DCO, CI on three systems, release pipeline, translations | done |
| **M1** ✅ | Pure review rules, harness adapters (Claude Code, Codex, Kiro, ACP, custom), `doctor --conformance`, `crewreview local` | done |
| **M2** 🟡 | GitHub and GitLab adapters, linked repositories, mirror, SQLite state, reviewer daemon, inbox, posting | GitHub verified live; GitLab by contract tests, live check pending |
| **M3** 🟡 | The attendant: fix, reply, decline or leave to you; checks, signed commits, push without force, re-review; polish loop | GitHub verified live; GitLab live check pending |
| **M4** ✅ | Dashboard, local API, `service install`, signed `update` → **v0.1.0** | released once the signing key is in the repository's secrets |
| — | MCP server and skill for coding agents, website in five languages | done, unreleased |

## Still owed from the first plan

- **Limits that act**: pause a harness when its quota runs out and resume at the reset time, fall back to the next harness, a daily budget in review units, and a "what would run now" simulator before switching a repository to auto.
- **Attendant items for conflicts and red CI** on your own pull requests.
- **`doctor` checks that each harness is signed in for unattended use** (services run without your terminal's login).
- Keep-awake while a job runs.

## v0.2: going public

- Make the repository public; GitHub Sponsors and Buy Me a Coffee in `FUNDING.yml`, on the site and in the README.
- Site at crewreview.web.app (later crewreview.dev), deployed from `site/` by CI.
- Signed and notarized macOS binaries (Developer ID), Homebrew tap, Scoop and winget manifests, an install script.
- Listings: the MCP Registry, the Claude Code plugin marketplace (MCP server + skill + `/crewreview` command), awesome lists.
- Launch kit: a short demo video, posts for Show HN, Product Hunt, dev.to, Reddit and LinkedIn, in English and Portuguese.

## Being found (SEO and GEO)

People search for a pain, not for a name. Every page answers one:

- **Problem pages**: "answer pull request review comments automatically", "AI code review for self-hosted GitLab", "use Claude Code / Codex as a code reviewer", "review my branch before I open a pull request", "AI code review without sending code to a new vendor".
- **Comparison pages** (`/vs/`), factual and kept current: CodeRabbit, Qodo Merge / PR-Agent, Kodus, GitHub Copilot code review, Greptile.
- **Docs** with one page per command and setting, in five languages, since agents read docs to answer "how do I…".
- **For AI assistants**: `llms.txt` and `llms-full.txt`, FAQ and HowTo structured data, a stable feature list, plain answers near the top of each page. Bing Webmaster Tools (ChatGPT search), Google Search Console, IndexNow on deploy.
- **Proof**: a public benchmark of findings on seeded bugs per harness, with cost and time, rerun each release.

## M5: desktop app

Tauri 2 shell around the dashboard: tray icon with inbox count, notifications, starts the daemon, updates itself (signed). Notarized on macOS with Developer ID; installers for Windows and Linux. Needs the Rust toolchain.

## M6: breadth

Bitbucket (Cloud and Data Center), Azure DevOps, Gitea/Forgejo; verified OpenCode, Pi, Gemini CLI, Cursor, Copilot CLI and Antigravity; a terminal UI (`crewreview top`); webhooks for instant reviews; a Docker image for a shared team machine.

## M7: mobile companion

iOS and Android apps under the developer account: pair with the daemon by QR code, over the local network or Tailscale; push notifications; approve reviews and answers from the phone.

## M8: crew mode, from task to pull request

Give the crew a task (a sentence, an issue, a Jira or GitHub issue link) and it works end to end, with the review crew as the quality gate:

1. **Plan**: read the repository and the task, write a short plan with the files it expects to touch; you approve it (inbox) or let it go (auto).
2. **Build**: an agent implements it in a worktree, runs the project's checks, commits with your identity.
3. **Self-review**: the lenses and the verifier review the branch; the polish loop fixes until it's clean or the rounds run out.
4. **Open the pull request** with a description written from the plan and the review.
5. **Answer**: the attendant handles human reviews, CI failures and conflicts, and asks for another look.
6. **Hand over**: merging stays with a person.

Multi-agent by design: planner, builder and reviewers can be different harnesses and vendors, each with the lock its role needs (read-only for review, worktree-only for building).

## Principles

- The model proposes; code decides.
- Agents never hold your git host token.
- Read-only means read-only, and write means "inside the worktree", proven on your machine.
- Nothing leaves your machine except what goes to the harness you picked.
- Merging stays human.
- Everything a user sees is translated.
