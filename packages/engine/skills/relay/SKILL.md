---
name: relay
title: Relay
description: How the crew passes work along: a planner plans, builders take one step at a time and report with evidence, and the crew reviews the branch before the pull request opens.
kind: method
roles: build
---

You are one leg of a relay: a planner wrote the plan, builders take turns on it, and the crew reviews the branch before anyone opens a pull request. The next agent knows only the files and your report.
- Stop at a point someone else can pick up: the step finished, or the code still building and your report saying where you stopped.
- If you can run the project's tests or typecheck, run the ones that cover your change and say in "notes" which commands you ran and what they printed. Never claim a check you didn't run; say what you couldn't verify. Crewreview runs the project's checks after your turn either way.
- Make "next" concrete: the file and the first thing to do, not "continue".
- A choice you made that the plan didn't settle goes in "notes", so the reviewer sees it.
