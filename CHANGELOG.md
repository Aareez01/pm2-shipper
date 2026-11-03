# Changelog

## [0.1.0] - 2026-11-03

First release.

### Fixed

- **`FileFollower.open()` now releases any descriptor it already holds.** It assigned
  over `this.handle`, so re-opening a live follower leaked the previous descriptor: ten
  opens cost ten descriptors, measured. No current caller re-opens a live follower, so
  this was latent rather than an active leak, but nothing in the type or the API stopped
  one, and the failure mode for a process that follows files for weeks is `EMFILE`.
  Found because Node 26 turned "a FileHandle was closed by the garbage collector" from a
  deprecation warning into a hard error, which surfaced the same class of bug in the
  tests: they built pipelines and never called `closeAll()`, so the suite leaked
  descriptors and never exercised the shutdown path. Both are fixed; the pipeline tests
  now close in an `afterEach`.

### Dependencies

- `zod` 4.6.7 and `vitest` 5.x. zod below 4.6.6 accumulates one issue object per failing
  array element with no cap (GHSA-mrhx-c7xc-m3w5, high); no release of this module ever
  shipped an affected version. Array schemas also carry explicit length caps, because the
  4.6.6 fix only short-circuits when a length constraint is present.
- **Requires Node 22 or newer.** 18 and 20 are past end of life and the test runner cannot
  execute on them; verified on 22, 24 and 26 by running the suite, not by asserting it.
