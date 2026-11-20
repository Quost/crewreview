# Roadmap

Crewreview starts as a crew of AI agents for pull requests: reviewers that look at other people's changes, and an attendant that answers the reviews on yours. It runs locally, on macOS, Linux and Windows, with the harnesses you already use. Where it's going: give it a task, and the crew builds it, reviews it, answers the reviews and hands you a pull request that's ready for a human.

## Shipped

| | What | Status |
|---|---|---|
| **M0** ✅ | Repository, AGPL-3.0, DCO, CI on three systems, release pipeline, translations | done |
| **M1** ✅ | Pure review rules, harness adapters (Claude Code, Codex, Kiro, ACP, custom), `doctor --conformance`, `crewreview local` | done |
| **M2** 🟡 | GitHub and GitLab adapters, linked repositories, mirror, SQLite state, reviewer daemon, inbox, posting | GitHub verified live; GitLab by contract tests, live check pending |
| **M3** 🟡 | The attendant: fix, reply, decline or leave to you; checks, signed commits, push without force, re-review; polish loop | GitHub verified live; GitLab live check pending |
| **M4** ✅ | Dashboard, local API, `service install`, signed `update` → **v0.1.0** | released 2026-11-19; a 0.0.9 binary updated itself to it, signature and checksum verified |
| **v0.2** ✅ | Public launch: notarized macOS binaries, installers, Homebrew and Scoop, Claude Code plugin, MCP server and skill, website in five languages | released 2026-11-19 |
| **M5** ✅ | Desktop app for macOS, Windows and Linux, signed updates, simpler install on the site → **v0.3.0** | released 2026-11-19; installers checked on macOS and Linux, Windows not yet run |
| **v0.4** ✅ | Organizations and groups, limits that act, "what would run now", keep-awake, login checks, the attendant on conflicts and red CI | released 2026-11-20 |
| **v0.5** ✅ | First-run setup in the dashboard and the desktop app; a Docker image for a shared team machine | released 2026-11-20; 0.5.1 the same day with fixes to the setup |
| **v0.6** ✅ | Post reviews as a second account, so someone working alone can have their pull requests approved | released 2026-11-20; the approval itself still to check with a second account |

## Owed from the first plan ✅ (v0.4.0)

Released in v0.4.0 on 2026-11-20:

- **Limits that act**: a harness that hits its usage limit pauses until the time its message gives and resumes by itself; a fallback chain takes over; `limits.dailyRuns` caps the agent runs of a day; `crewreview repo preview` and the dashboard show what would run now before you switch to auto.
- **The attendant fixes conflicts with the base (merge, never rebase) and red CI** on your own pull requests, opt-in per repository.
- **`doctor` shows each harness's login**, here and as the background service sees it; the crew checks it before a job.
- **Keep-awake** while agents work.
- **Link a whole organization or GitLab group**, asked for by the first team to try it.

Still open: a live GitLab check (needs a `glab auth login` on the test machine).

## v0.2: going public ✅

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

## M5: desktop app ✅

Released in v0.3.0: a Tauri 2 window around the dashboard; menu bar or tray icon with the inbox count; notifications for new inbox items; check now, open at login, quit; runs the crew it bundles (`crewreview run --desktop`) or shows the service's; restarts a crew that stops; signed updates with the release key, bound to the version. Notarized `.dmg` for macOS, NSIS for Windows, AppImage, `.deb` and `.rpm` for Linux, x64 and arm64.

Next: Windows code signing (Azure Trusted Signing). Released in v0.5.0: a first-run setup that checks the agents and the host login and links a repository.

## M6: breadth

Bitbucket (Cloud and Data Center), Azure DevOps, Gitea/Forgejo; verified OpenCode, Pi, Gemini CLI, Cursor, Copilot CLI and Antigravity; a terminal UI (`crewreview top`); webhooks for instant reviews.

Released in v0.5.0: a Docker image for a shared team machine ([guide](team-machine.md)).

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
