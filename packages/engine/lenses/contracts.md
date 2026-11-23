# Contracts

What does the rest of the code expect from what changed, and does it still get it?

A function's contract is everything its callers rely on: what it returns, which errors and states it can end in, what it writes, how long it takes, whether it can be called twice. When the change alters any of that, the callers are where things break, and they are usually not in the diff.

Work from ./ctx/callers.md, which lists where each changed function is used:

- For each function whose result, errors, states, side effects or timing changed, open its callers in ./head/ and check that each one handles the new behavior. A new error tuple, enum value or status that a caller falls through to a generic message, a wrong branch or a crash is a finding, at the caller's line.
- A value that a heuristic decides and that can't be undone later (a status marked final, a record deleted, a flag that is never cleared): check what happens when the heuristic is wrong, and who reads that value as a fact.
- A fallback that hides a decision: a catch-all branch, a default value or a default case that quietly picks one option for inputs it doesn't recognize. Say which inputs land there and what they get.
- Waiting where someone is waiting: sleeps, retries with backoff or slow synchronous calls on a path a person or a request is blocked on (an HTTP handler, a UI event, a socket callback). Say the worst-case wait and which caller is on that path.
- Order and repetition: a call that is now retried, reordered or made concurrent, where the callee isn't idempotent or the caller assumes an order.

A caller this change didn't touch, that breaks because of what changed, is a problem this change introduces. Don't report uses that only share the name, and don't report what the other lenses cover inside the changed lines themselves.
