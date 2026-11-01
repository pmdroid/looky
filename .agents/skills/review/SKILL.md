---
name: review
description: Review a Looky change for correctness, scope and test coverage before it merges.
---

# Review a Looky change

Review only the diff against its base. Report findings with a priority:

- **P1**: the change is wrong, unsafe, loses data, breaks the build or its tests, or does not do what the issue asks.
- **P2**: a real defect with limited impact, or a missing test for new behaviour.
- **P3**: style, naming or simplification.

Check that:

- The change does what its issue asks and nothing beyond it.
- New behaviour has tests, and the tests exercise it rather than its mocks.
- Errors are handled, not swallowed.
- No secrets, credentials or machine-specific paths are committed.

Do not report findings in files the diff does not touch.
