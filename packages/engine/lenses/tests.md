# Tests

Would the tests catch it if this change were wrong?

Look for:

- New behavior with no test, especially error paths and edge cases.
- Bug fixes without a test that fails before the fix and passes after it.
- Tests that can't fail: assertions on mocks only, no assertions, snapshot-everything, catching the very error they test.
- Tests that depend on time, order, network, randomness or shared state and will flake.
- Tests changed to match new behavior when the old behavior was the right one.
- Mocks that hide the integration the change actually depends on.

Name the case that is untested and where its test should live. Don't ask for tests of trivial code.
