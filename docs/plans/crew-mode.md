# Crew mode: roles, seats, handoffs and terminals

The plan for M8 in [the roadmap](../ROADMAP.md): give the crew a task and it goes from plan to pull request, with a different agent, model and effort for each job, sharing the work across the plans you pay for, and picking up where another agent stopped.

## What was asked

- Choose the harness, model and effort for each job: for example Opus high to plan, Opus medium to orchestrate, a fast Codex model at low effort or Sonnet to write code.
- Balance usage across your plans, and when one runs out, carry on with another. All of it configurable.
- Keep the plan, the handoffs and the progress where Crewreview can read them, so whoever continues knows where the work stopped, where it's going and how to go on.
- An orchestrator that opens and closes terminals and starts agents from code, the way Cockpit does, so you can watch them and step in.

## What exists today

- A model and an effort per harness (`[harness.claude] model`, `effort`), the same for every job that harness does.
- A separate harness for the verifier (`harness.verifier`).
- `harness.fallback`: harnesses that take over, in order, while the chosen one is paused at its usage limit; the pause ends at the reset time the harness reports.
- Daily limits on agent runs, usage per day in the dashboard, worktrees per job, and the read-only and write-scope proofs per harness.

What's missing is the step from "one agent per harness" to "an agent per job": a role decides which seats can do it, the router picks one, and a ledger carries the work from one seat to the next.

## What I think

It's the right shape, with one change: the orchestrator should be code, not a model. Deciding the next step, routing it to a seat, pausing at a limit, resuming with another seat and checking that a step is done are rules, and rules belong in `packages/core` with tests (the project's first principle: the model proposes, code decides). It also saves the most expensive tokens: orchestrating with Opus medium would spend a model on bookkeeping. A model gets the orchestrator seat only to propose changes to the plan when a step fails or the task turns out different from what the plan said. Code checks the proposal and you approve it in the inbox, or let it pass in auto.

## The design

### 1. Seats and roles

A **seat** is one agent the crew can hire: a harness, a model and an effort. A **role** is a job, with the seats that may do it and how to share it among them.

```toml
[seats]
planner = { harness = "claude", model = "claude-opus-5-5", effort = "high" }
lead = { harness = "claude", model = "claude-opus-5-5", effort = "medium" }
fast = { harness = "codex", model = "gpt-6.1-sol", effort = "low" }
sonnet = { harness = "claude", model = "claude-sonnet-5-5", effort = "medium" }

[roles]
plan = ["planner"]
orchestrate = ["lead"]
build = { seats = ["fast", "sonnet"], balance = "spread" }
review = ["sonnet", "fast"]
verify = ["lead"]
attend = ["sonnet"]
```

- **balance** is one of three ways to share:
  - `order` (the default): the first seat until it's paused, then the next. This is today's `harness.fallback`, which becomes a shorthand for it.
  - `spread`: share by headroom, so each plan is used evenly.
  - `cheapest`: the lowest cost per run that's still available.
- **Each seat has its own limits:** runs, tokens and dollars per day, plus a pause at the usage limit with the reset time.
- **A role states the locks it needs.** Review and verify need the read-only proof; build and attend need the write-scope proof. A seat whose harness hasn't passed is refused when the config loads, with the reason on the page and in `doctor`. The model name is passed as you wrote it; `doctor` checks that the harness accepts it.
- **Today's settings keep working.** Without `[roles]`, today's settings become seats: `harness.default`, `verifier`, `fallback`, and the per-harness `model` and `effort`. Nobody has to migrate.
- **A Team page shows the seats as employees.** Each has a name, the role it holds, what it's doing now, today's usage, and whether it's paused and until when. This is the "employees" idea from earlier, and it makes the product easy to explain.

### 2. The task ledger

Each task gets a folder in Crewreview's data directory. Code writes it; agents read it as fenced context and never write it themselves.

```
tasks/<id>/
  task.md          the ask and where it came from (a sentence, an issue, a Jira link)
  plan.md          the approved plan: steps with ids, files each expects to touch, how each is checked
  state.json       the current step, attempts, which seat did what, pauses
  handoffs/
    003-build-fast.md   what was done, what's next, open questions, files touched
  log.jsonl        every event, for the history and the replay
```

- **Every agent ends with a structured handoff:** done, next, blockers. Code turns it into `handoffs/NNN-<role>-<seat>.md`.
- **The next agent gets the whole picture:** the task, the plan, the last handoff, `git diff --stat` of the branch so far, and the checks that fail. That's "where it stopped, where it's going, how to go on".
- **Where to read it:** the dashboard has a Task page. `crewreview task show <id>` prints it in a terminal. The MCP server gets a `task` tool, so your own Claude Code or Codex session can read a crew task, or continue it.

### 3. When a plan runs out mid-step

- A usage-limit error marks the step *interrupted*, says which seat, and when its limit resets. The worktree stays as it is.
- The router gives the step to the next seat of that role.
- An agent cut off at its limit can't write its handoff, so code writes it: the step, its last tool calls, the diff so far and the checks.
- With no seat left, the task waits and tells you when it can go on. The menu bar shows it, and the phone too, once there is a mobile app.

### 4. Terminals

An agent runs through a **runner**, and the runner is chosen in the config.

- **headless:** today's runner, a process whose JSON output streams into the dashboard.
- **tmux:** each agent in a window of a `crewreview` session. `tmux attach` shows them all, and closing a window stops that agent.
- **Cockpit:** each agent in a Cockpit tab, opened and closed through Cockpit's CLI. I need the link to the Cockpit remote / Pi project you mentioned, to build against its real interface.

Two more things work with any runner:

- **Open in terminal:** a running or finished agent opens in an interactive session you can type into. Claude Code and Codex resume a session by its id, so you take over exactly where the agent is.
- **The Now page becomes a grid of agents.** Each shows its live transcript with stop, open-in-terminal and close.

The locks don't change. An interactive takeover is you at the keyboard, not the crew, so it runs without the read-only or worktree locks, and the page says so.

### 5. Where tasks come from

The five steps in the roadmap's M8:

1. Plan.
2. Approve.
3. Build in a worktree with the project's checks.
4. Self-review with the polish loop.
5. Open the pull request; the attendant answers the reviews, and merging stays with a person.

The tasks come from a sentence in the dashboard, `crewreview task "…"`, a GitHub or GitLab issue with a label you choose, or a Jira issue.

## Milestones

| | What | Ready when |
|---|---|---|
| **M8.1** | Seats and roles, for the jobs that exist today (lenses, verifier, attendant): config, router, `order`, `spread` and `cheapest`, limits per seat, the Team page | A review's lenses run on two seats of two vendors, and the second takes over when the first hits its limit, live |
| **M8.2** | The task ledger and `crewreview task`: a sentence → plan → approval → build → self-review → pull request, with handoffs and resuming on another seat | A task finishes on a seat other than the one that started it, from the handoff alone |
| **M8.3** | Runners: tmux and Cockpit; open in terminal; the grid of agents | Watching and taking over a running agent from a terminal tab |
| **M8.4** | Task sources: GitHub and GitLab issues by label, Jira | An issue labeled `crew` becomes a pull request |
| **M8.5** | The orchestrator seat: a model proposes plan changes when a step fails; code checks them, you approve | A failed step comes back as a revised plan in the inbox |

M8.1 first: it pays off right away in what the crew already does (cheaper lenses, a stronger verifier, no stop when one plan runs out), and everything after it builds on the router.

## Open questions

- **Cockpit:** the link to the Cockpit remote / Pi project, to integrate its interface instead of guessing.
- **Model names:** each harness takes its own (Claude Code `--model`, Codex `-m`). Crewreview passes what you write and `doctor` checks it. Do you want a list to pick from in the app, or free text?
- **Budgets:** limits per seat in runs, tokens or dollars? Dollars only exist where the harness reports cost (Claude Code and Codex today).
