# Changelog

## [0.2.0] - 2026-11-04

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

### Security

- **`zod` upgraded to 4.6.7, and every array schema given an explicit `.max()`.** Below
  4.6.6, zod accumulates one issue object per failing array element with no cap
  (GHSA-mrhx-c7xc-m3w5, high). 0.1.0 shipped `zod ^3.23.8` and is affected.

  The advisory's own remediation is not sufficient here. Its description blames arrays
  *without* a length constraint; its title says *constrained* collections. Only the title
  is right - the 4.6.6 fix is an early exit taken when a length check fails, so it does
  nothing for an unconstrained array. Measured against this module's real config parser:

  | schema | zod 3.25.76 | zod 4.6.7 |
  | --- | --- | --- |
  | `z.array(...)` uncapped | 300k issues, 97 MB | 300k issues, 137 MB |
  | `z.array(...).max(10)` | 300k issues, 84 MB | 1 issue, 0 MB |

  Upgrading alone would have left parsing marginally worse while turning `npm audit`
  green, which is the worst of the available outcomes. Both halves were applied. Two
  million bad elements now cost one issue and under 50 ms.

  It was not reachable in this module: every zod call site parses the operator's own
  config file, and anyone who can write that file has better options than an allocation.
  This is hardening, and it clears the advisory for anyone auditing their dependencies.

### Removed

- **Support for Node 18 and 20** (breaking). Both are past end of life, and the test
  runner no longer executes on them, so the previous `>=18` was a claim that could not be
  verified. Supported range is now `>=22`, tested on 22, 24 and 26 by running the suite
  rather than asserting it.

### Changed

- `vitest` upgraded to 5.x, which closes a critical prototype-pollution advisory in its
  `tinypool` dependency (GHSA-5gmw-xhrv-c9v3). Development only; it never shipped.

## [0.1.0] - 2026-11-03

First release.

