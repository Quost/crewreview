# Tests

Would the tests catch it if this change were wrong?

Look for:

- New behavior with no test, especially error paths and edge cases.
- Bug fixes without a test that fails before the fix and passes after it. For each new or changed test, ask what it would assert if the fix were reverted: one that passes either way proves nothing.
- A bug fix where the existing tests should have caught the bug: say why they didn't (a mock, a fixture that never hits the case, an assertion too loose), since that gap still hides the next one.
- Tests that can't fail: assertions on mocks only, no assertions, snapshot-everything, catching the very error they test.
- Tests that depend on time, order, network, randomness or shared state and will flake.
- Tests changed to match new behavior when the old behavior was the right one.
- Mocks that hide the integration the change actually depends on.

Name the case that is untested and where its test should live. Don't ask for tests of trivial code.
