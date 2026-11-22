# Changelog

Notable changes to Crewreview. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## Unreleased

- Keep failed thread resolutions retryable without posting the same reply twice.

## 0.14.1 — 2026-11-21

Reviews that read the whole change, fair to every lens, and posted once on GitLab.

### Fixed

- A minified bundle in a change could hide the rest of it from the crew. One megabyte-long line in `public/app.js` filled the diff, the agents couldn't read past it, and the files after it (the server code among them) went unreviewed. Minified, generated and oversized files now stay out of the diff the agents read, with only their header and a note. The review lists them as left out, and their lines don't count toward `limits.maxDiffLines`.
- A whole lens could be thrown away as invented over one file. If a lens cited two files and one of them was missing, every finding it had was dropped. A symlink the change adds counted as missing when it pointed outside the repository. Now a lens is set aside only when two or more of the files it cites are missing, a link counts as the one-line file git stores, and a link is never followed outside the tree.
- A retry on GitLab could post the same review twice. GitLab can answer 500 to a batch publish and still publish it, and the retry posted everything again. It now skips the comments and the summary that are already on the merge request. The footer and markers carry the version that ran the review, not the one that posted it, and a post that goes through clears the error from the earlier attempt.
- Each agent's raw answer is kept in `agents/` next to the review's report, so a bad review can be looked into.

## 0.14.0 — 2026-11-20

Tasks in the app: give the crew a task, approve it from the dashboard, let the daemon carry it, and choose who opens the pull request.

### Added

- A Tasks page in the dashboard: give the crew a task (the repository, what to do, who does it, whether it waits for you), read the plan and approve it, follow each step, the self-review and the handoffs, and open the pull request. The nav shows how many tasks wait for you.
- The daemon carries tasks forward in the background, one at a time: a task you create or approve starts right away, without waiting for the review cycle, and reviews don't wait for a task. Its planner and builder show on the Now page as agents of their own, and its milestones (plan ready, step committed, self-review, pull request opened, waiting, needs you) in the activity.
- Who does a task: you (your identity, signature and account), or the crew's account, the repository's second account. Then the commits carry its name, it pushes, and it opens the pull request, so you're not the author and can approve and merge it yourself. It's the default when the repository has a review account; `crewreview task --as you|crew` picks it from the command line.

## 0.13.0 — 2026-11-20

Crew mode, preview: give the crew a task, and it plans, builds, reviews itself and opens the pull request.

### Added

- Crew mode, preview: `crewreview task "…" --repo <id>` takes a task to a pull request. A planner proposes small steps with their files, checks and risks, and you approve. A builder does one step per turn in Crewreview's own checkout; the repository's validate commands run after each step, never commands from the plan, and each finished step is committed with your identity. The crew reviews its own branch and fixes what's blocking. After you approve again, it opens the pull request with the plan, the risks and the self-review's findings. `task list`, `show`, `approve`, `run` and `cancel` follow it, and `--auto` skips both approvals.
- Every agent's report lands in a ledger (`tasks/<id>/` in the data folder: the task, the plan, numbered handoffs, the agents' raw answers, a log), so any seat can continue the task. A builder cut off at its usage limit gets a handoff written by Crewreview from what it left, and the next seat of the `build` role takes the step over. A blocker, too many turns, or three turns that finish nothing stop the task and ask you.
- `plan` and `build` roles for seats, and `[task]` settings: `maxTurns`, `maxReviewRounds`, `branchPrefix`.

## 0.12.1 — 2026-11-20

Posting reviews on GitLab, fixed, and an activity log that says what it means.

### Fixed

- Posting a review on GitLab could fail with "500 Internal Server Error" on `draft_notes/bulk_publish` (seen on GitLab 19.5). A comment on an unchanged line went without its old line number and the file's old path, so GitLab saved the draft but couldn't place it, and then failed the whole batch. Comments now carry both. A draft GitLab still can't place goes into the summary instead, and if the batch fails anyway, each comment is published on its own.
- Publishing the batch also published drafts you had written yourself on that merge request. The crew now publishes only its own drafts; when you have some pending, it publishes its own one by one and leaves yours alone.
- Retrying a post that failed left the first attempt's drafts behind, and would have posted them twice. The crew now removes its own leftover drafts first, recognized by its hidden marker.
- A merge request larger than `limits.maxDiffLines` showed "failed: diff-too-large", and then "failed too many times on this commit" on every check. It now says, once, that it's too large, with its size and the limit, and leaves it until a new commit.
- The same skip ("it's a draft") was logged again on every check. Each one is now said once per commit and reason.
- The check line said "pending" for pull requests queued for the next check, which read like the inbox. It now says "queued for the next check".

## 0.12.0 — 2026-11-20

Seats and roles: a model and an effort for each job, shared across the plans you pay for, with a Team page.

### Added

- Seats and roles, the first part of crew mode ([plan](docs/plans/crew-mode.md)). A seat is an agent with a model and an effort (`[seats] fast = { harness = "codex", model = "…", effort = "low" }`). `[roles]` says which seats review, verify and answer reviews, and how they share the work: `order` (the next takes over when one is paused or out of runs), `spread` (each plan used evenly, lenses running at once land on different seats) or `cheapest`. A lens or verifier that hits its usage limit carries on at once on the next seat, and the seat pauses until its limit resets, with any other seat on the same harness and model. Seats can have their own `dailyRuns`. Without `[roles]` nothing changes.
- A Team page in the dashboard: each seat as a member of the crew, with its jobs, model and effort, what it's doing now, today's runs and its pause; the jobs and how they share their seats; and how to set it up. `doctor` lists the jobs and their seats, and warns about a seat whose harness isn't installed. The terminal shows which seat ran each lens.

### Fixed

- Right after linking a repository or group, every open pull request was skipped as "waiting for pushes to settle", even ones pushed days ago with a green pipeline: the wait counted from when the crew first saw the commit. It now counts from the host's last update, and the message says what it means (pushed a moment ago).
- An attendant run that hit its usage limit didn't pause its harness, so the next cycle tried it again.

## 0.11.0 — 2026-11-20

A second account on GitLab with one pasted token, and every first-run flow walked through and fixed.

### Fixed

- `doctor` and the setup said glab wasn't signed in, or hid a company GitLab, whenever another configured host didn't answer: `glab auth status` checks hosts one after another and gave up after the first slow one. Each host in glab's config is now checked on its own, at the same time, for 8 seconds at most.
- Answers that ask the git hosts first (who you are on each, a large GitLab group) were cut after 10 seconds, leaving the page waiting forever. The dashboard's server now waits up to two minutes, and the setup keeps the hosts it showed while it checks again.
- Linking a repository, or resuming a paused one, now starts a check right away instead of at the next cycle.
- The Docker image named the version about to be released, so building it from main between a version bump and its release failed. It now installs the latest published release unless you pin one with `--build-arg VERSION=`.
- The second-account setup was a dead end without a linked GitHub repository, and had nothing for GitLab: every button stayed disabled. It now starts with where the account will review, links a repository, organization or group right on the page when nothing is linked, and then takes the path of that host.

### Added

- `crewreview status`: whether the crew runs on this computer, what it's doing, when it checks next and what waits in the inbox. Exits 3 when it isn't running.
- Prove any agent not proven yet from Harnesses & limits, the built-in ones included, not only those that need the proof to review.
- When a preview finds only your own pull requests, it says how to have them reviewed (Whose pull requests: everyone's) and approved (a second account), with a link to the setup.
- A second account on GitLab with an access token: a group or project access token creates a bot account by itself, so nobody signs up. The app opens the token page of your group or project, lists what to fill in, and you paste the token. It checks who the token belongs to, refuses your own, asks each place what the account can do there (can approve, read only, no access) and uses it only where it reaches. A group token covers its subgroups.
- On GitHub, the second account can sign in by pasting a classic token of it, instead of the `gh` sign-in code: the crew accepts its invitations, checks the access and uses it.
- Pasted tokens live in the system keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux), never in a file; a repository refers to one as `keychain:<host>/<user>`.

## 0.10.0 — 2026-11-20

More agents (Antigravity, OpenCode, Gemini CLI), proven from the app, and a setup that knows your company GitLab.

### Fixed

- The setup showed "no login" for gitlab.com while glab was signed in to a company GitLab. It now lists the hosts gh and glab are actually signed in to (a configured host whose token fails doesn't count), and shows gitlab.com only when no other GitLab is known.
- Previewing a GitLab group by its address (`gitlab.example.com/group/subgroup`) treated it as a project and failed with "404 Project Not Found". The preview now asks GitLab whether the path is a group, as linking does, and then covers its subgroups. For an organization or group it also says how many repositories it holds and names the ones with open pull requests.

### Added

- Antigravity (`agy`), OpenCode and Gemini CLI built in, over the Agent Client Protocol: they show up when installed, with no config. Crewreview answers their permission requests, so read-only holds, and they review once they pass the read-only proof. Antigravity 1.5.13 passes read-only and write scope, so it can answer reviews too.
- Prove an agent's read-only lock from the app (setup and Harnesses & limits), instead of `doctor --conformance` in a terminal. It runs in the background and the list shows the result.

### Changed

- The website counts visits with GoatCounter (no cookies, nothing personal; a line in the footer says so), including downloads and copied install commands as events, so it's clear where people come from and what they do next. Links to it from the README, the Claude Code plugin, Homebrew, Scoop, the app and the launch posts carry `?ref=` for that.

## 0.9.0 — 2026-11-20

Run it from the app: settings, open at login, pausing repositories, and approvals from the menu bar.

### Added

- Settings in the app: everything under Limits and schedule is now a form (how often to check, peak hours, reviews and answers per check, keep-awake, agents at once, runs per day, time limits, the agent for reviews and the verifier, waits after a push or new comments, automatic approvals, update checks). Saving changes only those lines of config.toml, your comments included, and the crew uses the new values at once.
- Open at login, from the app's settings as well as its menu.
- Choose the agent for reviews right in the setup: a "Use for reviews" button on each agent that's ready. The settings have it too.
- Approve from the menu bar (macOS) or the tray: Inbox lists what waits for you, each item with Approve (after a confirmation that names the pull request, since it posts on the host), Open (that item in the dashboard) and Discard. A notification says how it went.
- Pause a repository or a whole organization without unlinking it (the Active switch, or `crewreview repo set <id> --paused on`): no reviews or answers until it's back on. A repository paused on its own stays paused inside an active organization.

## 0.8.0 — 2026-11-20

A first contact that looks the part: a disk image that says what to do, a native app icon, and the next steps on the website right after the download.

### Changed

- The macOS disk image says what to do: "Drag Crewreview into Applications", an arrow from the app to the Applications folder, and a sharp background on Retina screens. The icon labels stay readable in light and dark mode, and hidden files stay out of view even when Finder shows them. The image is now built with dmgbuild, which writes the layout into it, because Tauri's skipped its layout on CI.
- A new app icon: transparent corners instead of white ones, and on macOS the margins and shadow of a native icon.
- The website: right after you click download, it shows the next three steps for your system, with a short animation (dragging into Applications on macOS, the SmartScreen warning on Windows, chmod on Linux). Reduced motion is respected.

## 0.7.1 — 2026-11-20

The desktop app finds your agents and your GitHub login when opened from the Dock.

### Fixed

- The desktop app found no agent and no GitHub login when opened from the Dock, Finder or a desktop launcher: such an app starts with a bare PATH (/usr/bin:/bin), not your terminal's. The crew it starts now takes PATH, and the few variables the background service keeps, from your login shell, plus the usual install folders. Program lookups now always use the current PATH.

## 0.7.0 — 2026-11-20

The second account, set up from the app: you create it and type one code; the app does the rest.

### Added

- A guided setup in the app for the second account that posts your reviews (Repositories → Post reviews as → Set it up step by step, or from the first-run setup). GitHub only lets a person create the account and type its sign-in code; the app does the rest:
  - it checks the username and refuses your own;
  - with your account, it invites the new one to your GitHub repositories with write access;
  - it signs the new account in to gh with a one-time code you type at github.com/login/device. No browser is opened for you, so you can use a private window. Then it switches gh back to your account, whatever happened;
  - with the new account's token, it accepts the invitations and points the repositories at it.
- The local API answers `/api/account/user`, `/api/account/invite`, `/api/account/signin` (start, follow, cancel) and `/api/account/accept`.

## 0.6.0 — 2026-11-20

For anyone working alone: reviews can post as a second account, so your own pull requests can be approved.

### Added

- Post a repository's reviews as a second account (`crewreview repo set <id> --account my-bot`, or **Post reviews as** in the dashboard), so someone working alone can have their own pull requests approved: GitHub doesn't let you approve your own. The token comes from `gh`, which keeps several accounts per host, or from an environment variable with `env:VARIABLE` (GitLab, Docker). The account is checked before it's saved, your own is refused, and a review whose account can't be found waits in the inbox instead of posting as you.

## 0.5.1 — 2026-11-20

Fixes for the first-run setup, found by using it against a real crew.

### Fixed

- The setup page said the agent for reviews wasn't ready when `harness.default` is `auto`, the default. It now names the agent `auto` picks; `/api/harnesses` marks it as `chosen`.
- A preview that failed said it couldn't link, and a dashboard that lost its crew showed "TypeError: Failed to fetch". Both now say what happened.
- "Watching 0 repositories" and "0 repositório" read naturally in every language.

## 0.5.0 — 2026-11-20

Easier to start, alone or as a team: a first-run setup, and a Docker image for a shared team machine.

### Added

- A first-run setup in the dashboard and the desktop app. While nothing is linked it opens by itself and goes through the agents and their login, access to GitHub or GitLab (and as whom), a preview of what a repository or organization would start, and linking it in inbox mode. Later it's one click away, under Repositories.
- A Docker image for a shared team machine, where one bot account reviews the team's pull requests ([guide](docs/team-machine.md)). It installs the release binary only after checking its signature, comes with Claude Code and Codex, keeps the config, history and agent logins in one volume, and the dashboard is reached over SSH.
- The local API answers `GET /api/hosts` (which git hosts this machine can reach, and as whom) and `POST /api/preview` (what an address that isn't linked yet would start).

### Fixed

- The Homebrew instructions in the README, on the site and in the setup prompt: `brew install Quost/crewreview/crewreview` looked for a tap repository that doesn't exist. It's now `brew tap Quost/crewreview https://github.com/Quost/crewreview`, `brew trust quost/crewreview` (recent Homebrew asks for it) and `brew install Quost/crewreview/crewreview`.

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
