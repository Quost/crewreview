# A shared team machine

Most teams don't need this: each developer runs Crewreview with their own agent plan, and reviews post from their own account. A shared machine is for when you'd rather have **one bot account review every pull request** of the team, all day, from a server or a spare computer.

You get the daemon, git, Claude Code and Codex in one Docker image, built from the official release binary after its signature is checked. Everything that should last lives in one volume.

## What you need

- A Linux machine with Docker and Docker Compose, that you reach over SSH.
- **A bot account** on GitHub or GitLab, with access to the repositories. Reviews post as this account.
  - GitHub: a fine-grained token for the bot, limited to the repositories, with read access to *Contents*, *Metadata*, *Checks*, *Commit statuses* and *Actions*, and read and write access to *Pull requests*.
  - GitLab: a group or project access token with the `api` scope.
- **An agent login** for the machine. With an API key you pay per use and stay clear of plan terms: `ANTHROPIC_API_KEY` for Claude Code, `OPENAI_API_KEY` for Codex. Read your provider's terms before you put a personal plan on a shared machine.

## Start it

```bash
mkdir crewreview && cd crewreview
curl -fsSLO https://raw.githubusercontent.com/Quost/crewreview/main/docker/Dockerfile
curl -fsSLO https://raw.githubusercontent.com/Quost/crewreview/main/docker/compose.yml
```

Put the tokens in a `.env` file next to `compose.yml`, readable only by you (`chmod 600 .env`):

```bash
GH_TOKEN=github_pat_…
ANTHROPIC_API_KEY=sk-ant-…
```

Then build, start and check:

```bash
docker compose up -d --build
docker compose exec crewreview crewreview doctor
```

`doctor` shows each agent and whether it's signed in. You can also sign in inside the container instead of passing a key: `docker compose exec -it crewreview claude auth login`. The login is kept in the volume.

## Link the repositories

```bash
docker compose exec crewreview crewreview repo add https://github.com/acme
```

A whole organization or group, or one repository. Links start in **inbox mode**: reviews wait for someone to approve them. Preview first with `crewreview repo preview <address>` to see what the crew would review right now.

The git host token stays with Crewreview: agents get a filtered environment without it. They run read-only to review.

## Approve from your laptop

The dashboard listens on `127.0.0.1:4620` of the machine only. Open a tunnel and ask for the address, which carries the key for the session:

```bash
ssh -L 4620:127.0.0.1:4620 team-machine
docker compose exec crewreview crewreview ui
```

Open the printed address in your browser. From the terminal, `crewreview inbox` lists what waits and `crewreview inbox approve r12` posts one.

When the team trusts it, switch a repository to auto in the dashboard or with `crewreview repo set <id> --mode auto`.

## Update

The daemon tells you, in the dashboard, when a new release is out. To move to it, rebuild with the new version:

```bash
docker compose build --build-arg VERSION=0.5.0 && docker compose up -d
```

`CLAUDE_CODE_VERSION` and `CODEX_VERSION` pin the agents' versions the same way; they default to the latest.

## Limits worth setting

On a shared machine, cap what the crew may spend in a day. Write a `config.toml`:

```toml
[limits]
dailyRuns = 300          # agent runs a day, across all repositories
maxConcurrentAgents = 3

[harness]
fallback = ["codex"]     # when Claude Code hits its usage limit
```

Copy it into the volume and restart:

```bash
docker compose cp config.toml crewreview:/data/config.toml && docker compose restart
```
