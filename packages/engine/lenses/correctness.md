# Correctness

Does the code do what the change says it does, in every case it will meet?

Look for:

- Logic errors: wrong conditions, inverted checks, off-by-one, wrong operator, unreachable branches.
- Inputs the code doesn't handle: null or empty values, zero, negative numbers, very large inputs, unicode, time zones.
- Error paths: exceptions swallowed or lost, failures reported as success, missing cleanup, partial writes.
- State and concurrency: races, shared mutable state, async work that isn't awaited, retries that aren't idempotent.
- Contracts: a caller that breaks because a function's behavior, signature or return value changed.
- Data: migrations that lose data or can't be rolled back, wrong types or units, precision loss.
- Resource leaks: files, connections, timers, listeners or subscriptions that are never released.

Read the callers and the callees of what changed. A function that looks right on its own can be wrong where it is used.
