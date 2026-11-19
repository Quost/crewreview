# Launch kit

Drafts for launch day. Adjust the numbers to what's true that day; never claim what wasn't measured.

## Launch-day checklist

1. `MACOS_SIGNING=true` and the four macOS secrets set; a test tag on a fork or a pre-release proves notarization.
2. Version bumped, CHANGELOG section written, tag pushed; the release has 5 binaries, `SHA256SUMS` and `.minisig`, and the Homebrew/Scoop manifests updated on main.
3. Repository public; description, topics (`code-review`, `ai`, `pull-requests`, `github`, `gitlab`, `claude-code`, `codex`, `mcp`, `open-source`) and the social preview image set.
4. Site `crewreview` created in Firebase project `crewreview-prd`, deployed; `crewreview.web.app` answers; `install.sh` works anonymously.
5. Install checks on a clean machine: `curl … | sh`, `brew install Quost/crewreview/crewreview`, `scoop install crewreview`, the Claude Code plugin.
6. Google Search Console and Bing Webmaster Tools: add the site, submit `sitemap.xml`.
7. Posts below, one channel at a time; answer every comment the first day.

## Show HN

**Title:** Show HN: Crewreview – local AI crew that reviews PRs and answers the reviews on yours

I kept doing two chores every day: reviewing teammates' pull requests, and going back to my own pull requests to fix and answer what reviewers asked. Crewreview does both, on my machine, with the coding agents I already pay for (Claude Code, Codex, Kiro, or any ACP agent).

How it works:
- A review runs several read-only "lenses" in parallel (correctness, security, architecture, tests, UI). Findings that don't point at a real file and line are dropped, duplicates merged, and a verifier (optionally another vendor) tries to prove each one wrong. A fixed rule, not the model, decides the verdict.
- On my own pull requests, an "attendant" reads new comments from people with write access, fixes in a worktree, runs my checks, commits with my identity and signature, replies, resolves the thread and asks for another look. Nothing is pushed by the agent: it never sees my git token.
- New repositories start in inbox mode: everything waits for approval in a local dashboard.
- Read-only isn't a promise in a prompt: `doctor --conformance` asks each harness to write a file and checks it couldn't. Codex's workspace-write sandbox, for example, also opens /tmp by default, and Kiro's fs_write isn't limited to the folder, so Kiro reviews but doesn't attend.

It's AGPL-3.0, TypeScript on Bun, single binary for macOS/Linux/Windows, five interface languages, updates signed with minisign, and the builds are reproducible.

Repo: https://github.com/Quost/crewreview · Site: https://crewreview.web.app

Happy to hear what breaks, and which hosts or harnesses you'd want next.

## Reddit (r/ClaudeAI, r/ChatGPTCoding, r/selfhosted)

**Title:** I built an open-source crew of AI agents that reviews PRs and answers the reviews on mine, locally, with Claude Code or Codex

Short version of the HN post, plus a GIF of the dashboard's live board, and one line per subreddit on why it fits (self-hosted: no server, no account, no telemetry; Claude/ChatGPT: uses your existing subscription, no API key).

## LinkedIn (PT-BR)

Todo dia eu fazia duas tarefas repetitivas: revisar os pull requests do time e voltar nos meus para corrigir e responder o que pediram na review. Transformei isso num projeto open source: o **Crewreview**.

Ele roda na sua máquina, com os agentes de IA que você já assina (Claude Code, Codex, Kiro…):
🔍 revisa PRs com várias "lentes" em paralelo e um verificador que tenta derrubar cada achado; o veredito sai de uma regra, não do modelo;
🛠️ nos seus PRs, corrige, responde e resolve as threads, e pede uma nova revisão; com commit assinado e sem nunca dar o seu token ao agente;
📋 tudo passa por um inbox para você aprovar, num painel em português (e mais 4 idiomas).

Gratuito, AGPL-3.0, para macOS, Linux e Windows. Feedback é muito bem-vindo 🙏
https://crewreview.web.app

## X / Bluesky thread

1. Reviewing PRs and answering reviews on mine were eating my day, so I built a crew of AI agents for it. Open source, local, uses the Claude Code / Codex you already have. 🧵
2. Reviewer: parallel read-only lenses → evidence check (file:line or it's gone) → a verifier tries to refute each finding → a fixed rule decides. [screenshot of a review]
3. Attendant: on your PRs, it fixes in a worktree, runs your checks, signs the commit, replies, resolves, asks for re-review. The agent never gets your git token. [screenshot of replies]
4. "Read-only" is proven, not promised: a canary asks each harness to write a file. Kiro's fs_write escaped the folder, so it reviews but doesn't attend.
5. AGPL-3.0, single binary, five languages, signed updates. crewreview.web.app

## dev.to article outline

"What I learned making AI agents review code you can trust": the model proposes and code decides; evidence or it didn't happen; a second vendor as verifier; proving read-only per harness version; why the agent never holds the token; numbers from the public benchmark.
