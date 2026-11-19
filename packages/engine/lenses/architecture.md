# Architecture

Six months from now, will this make the system easier or harder to change?

Look for:

- Responsibilities in the wrong place: business rules in controllers or views, I/O mixed into pure logic.
- Duplication of something the codebase already has: a second helper, client, config loader or model for the same job.
- Coupling: new dependencies between modules that were independent, circular imports, leaking internal types.
- Abstractions that don't pay for themselves, or a missing one where the same pattern now appears three times.
- Breaking the project's own written conventions (see ./ctx/guidelines.md) or the patterns of the surrounding code.
- Public interfaces (APIs, events, schemas, CLI flags) changed without versioning, migration or a note.
- Performance traps the design makes likely: queries in loops, unbounded lists, work on every request that could be done once.

Point to the existing code that should have been reused or followed, with its path.
