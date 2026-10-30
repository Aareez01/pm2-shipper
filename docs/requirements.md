# pm2-shipper — Requirements

**Status:** Built (0.1.0) · **Date:** 2026-10-31 · **Licence:** MIT
**Verified against:** PM2 7.1.1 (source inspection **and** experiment)

Depends on the shared platform constraints and wire contract, which live in the
**`pm2-ops-contract`** repository (`00-platform-and-contract.md`) because the whole suite is
bound by them. Read that first.

---

## 1. Problem

`pm2-logrotate` is the most-complained-about module in the ecosystem: open issues cover cluster
mode, `max_size` being ignored, a disk filling with 60 GB in a day, and Windows. Separately, nothing
in PM2 ships logs anywhere — there is no Loki, OTLP, CloudWatch or syslog output, so the logs stay
on the box they were written on.

These are the same problem. A rotator that does not understand who holds the file descriptor
corrupts the shipper's position, and a shipper that does not know when rotation happened loses data.
Shipping them as one module is the point.

**This module is different in kind from `pm2-liveness` and `pm2-alertmanager`.** Those are event-driven
and low-volume. This one sits in the path of every log line on the host, so its failure modes are
unbounded memory, silent data loss, and filling the disk it was installed to protect.

## 2. Goals / Non-goals

**Goals**
- Ship logs to a backend reliably, surviving module restarts and backend outages.
- Rotate correctly in cluster mode, with a hard disk-usage cap that is actually enforced.
- Structured output with app, instance, host and revision labels.

**Non-goals (v1)**
- Log *parsing* beyond JSON detection — no grok, no multi-line stack-trace joining (see Q3).
- Metrics or alerting derived from logs.
- Shipping anything that is not a PM2-managed app's output.

---

## 3. The delivery decision: tail the files, do not use the bus

This is the central design question and everything else follows from it. It is settled by two facts
about PM2 7.1.1.

### D1 — The bus has no delivery guarantee and no replay (F8)

`God.bus` events reach subscribers over a pub socket. A subscriber that is down, restarting or slow
misses them **permanently**. The module restarts whenever `pm2 set` changes its configuration (F3),
so this is routine, not exceptional.

A shipper whose premise is "your logs reach your backend" cannot be built on a transport that
silently drops them. **The bus is rejected as the primary source.**

### D2 — Files are durable and replayable, and PM2 always writes them

Both modes write to disk, and a byte offset survives a restart. Tailing is therefore resumable,
which the bus can never be.

The exception must be handled explicitly: `disable_logs: true`, or an out/err path of `/dev/null`,
means **no file exists**. PM2 still emits on the bus in that case, but there is nothing to tail.

- **REQ-SH-01** — Tail the files named by `pm_out_log_path` and `pm_err_log_path` from
  `pm2.list()`. Persist a per-file byte offset; on restart, resume from it.
- **REQ-SH-02** — Detect apps whose logs are disabled or directed to `/dev/null` and **report them
  as unshippable at boot**, naming the app. Silently shipping nothing for an app the user believes
  is covered is the worst outcome available.
- **REQ-SH-03** — The bus MAY be offered later as a low-latency supplement for such apps, behind an
  explicit opt-in that documents the loss semantics. Not in v1. (Q1)

---

## 4. Platform facts that constrain the design

Established by reading PM2 7.1.1 **and verified by experiment** before any code was written — lab
scenario 40, six assertions, against a 2-instance cluster app under continuous write. Recorded in
the platform document as F12–F13.

### In cluster mode the WORKER owns the log file descriptors

`ProcessContainer.js` intercepts `process.stdout.write` in each worker and writes to the log file
**from the worker process**, then forwards a copy to the daemon over IPC. The daemon's own
`StdioLogger` sees only what bypassed that interception — direct fd writes (pino, sonic-boom),
children spawned with `stdio: 'inherit'`, native addons.

**Consequence:** renaming a log file does not make PM2 write to a new one. Every worker keeps its
open descriptor and keeps appending to the renamed — or deleted — inode. The file vanishes from
`ls` while the disk keeps filling. This is the mechanism that makes "rotated but the disk still
filled" possible, and any rotator that ignores it is broken in cluster mode by construction.

### Reopening is explicit, per worker, and refusable

`God.reloadLogs` closes and recreates the daemon-side streams first, then sends
`{ type: 'log:reload' }` to each cluster worker, which closes its streams and calls
`Utility.startLogging` again. It deliberately skips workers whose IPC channel is closed, because
`send()` on a dead channel raises an async `ERR_IPC_CHANNEL_CLOSED` that **kills the daemon**.

**Consequence:** rotation is a three-step protocol, not a rename. A worker that is restarting during
rotation will not be notified and must be reconciled afterwards.

### Log paths are per instance unless `merge_logs` is set

`God.js` rewrites `pm_out_log_path` / `pm_err_log_path` to carry a `-<pm_id>` suffix unless
`merge_logs` is true, in which case every instance of an app appends to **one shared file**.

**Consequence:** the shipper must handle both layouts, and under `merge_logs` it cannot attribute a
line to an instance — only to an app.

---

## 5. Functional requirements

### 5.1 Tailing

- **REQ-SH-04** — Follow each file by offset, handling partial final lines: a chunk ending mid-line
  must be held, not shipped as a truncated record.
- **REQ-SH-05** — Detect rotation and truncation by `(dev, inode)` plus size, not by path. On an
  inode change, finish reading the old inode to EOF before switching, so the tail of a rotated file
  is not lost.
- **REQ-SH-06** — Reconcile against `pm2.list()` every 30 s so apps started, stopped or scaled are
  picked up without a module restart, and offsets for vanished instances are dropped.
- **REQ-SH-07** — Bound memory per file. A single pathological line must not be buffered without
  limit; cap it, ship the truncated line marked as such, and count the event.

### 5.2 Rotation

- **REQ-SH-08** — Rotate on size and/or on a schedule. `max_size` must be enforced by **checking
  actual file size**, which is the gap users report against the existing module.
- **REQ-SH-09** — Rotation is: (1) rename the file, (2) call PM2's `reloadLogs` so every worker and
  the daemon reopen, (3) only then compress the renamed file. Compressing before the reopen races
  with writers that still hold the old descriptor.
- **REQ-SH-10** — After rotating, verify the new file exists and is being written. If a worker was
  disconnected during `reloadLogs` and never reopened, log it and retry on the next cycle rather
  than assuming success.
- **REQ-SH-11** — **Hard disk-usage cap.** A total byte budget per app and for the module's log
  directory, enforced by deleting the oldest compressed archives. This is a cap, not a retention
  count: a retention count does not bound disk use when lines arrive faster than expected.
- **REQ-SH-12** — ⚠️ **Partially implemented.** The cap logs precisely what was dropped and how
  many bytes. It does **not** yet check whether an archive's contents were shipped before deleting
  it: retention evicts strictly oldest-first by mtime. In practice REQ-SH-27 keeps the live file
  from rotating while a backlog exists, so an unshipped archive is now rare — but "rare" is not
  "never", and this is the honest state rather than a claim.
- **REQ-SH-13** — Windows: `rename` fails on a file held open on Windows. Either implement
  copy-truncate there or **refuse to rotate and say so**. Silent Windows breakage is a documented
  failure of the incumbent and must not be repeated.

### 5.3 Output

- **REQ-SH-14** — ✅ **Implemented.** v1 backends: **Grafana Loki** and **OTLP/HTTP**.
  Elasticsearch, CloudWatch and syslog follow demand — OTLP already reaches most of them through
  an OpenTelemetry Collector, which is why no native AWS integration was written.

  Loki labels on `app`, `stream` and `host` only. `pm_id` is deliberately **not** a label: Loki
  indexes labels, so on a 16-instance cluster it would multiply the stream count by sixteen for
  something that belongs in the line body.
- **REQ-SH-15** — Each record carries `app`, `pm_id` (unless `merge_logs`), `host`, `stream`
  (`out`/`err`), `timestamp`, and `revision` where present.
- **REQ-SH-16** — If a line parses as JSON, ship it as structured fields rather than a string, with
  the original preserved. Otherwise ship it as a message.
- **REQ-SH-17** — Batch by size and time (defaults: 1 MB or 2 s, whichever first).

### 5.4 Backpressure and durability

- **REQ-SH-18** — On backend failure, retry with exponential backoff and **stop advancing the
  offset**. The file is the buffer; this is the advantage of tailing and must not be given away by
  acknowledging unshipped data.
- **REQ-SH-19** — If the backend is down long enough that rotation would delete unshipped data, the
  disk cap (REQ-SH-11) wins and the loss is logged explicitly with byte counts. A module that fills
  the disk to avoid losing logs has failed worse.
- **REQ-SH-20** — Offsets are persisted atomically (temp file + rename) and flushed at least every
  5 s, so a crash costs at most a few seconds of duplicate shipping — never a gap.
- **REQ-SH-21** — Delivery is **at-least-once**, within a stated boundary. Duplicates after a crash
  are acceptable; gaps are not.

  *Boundary found by testing, after the README had already claimed otherwise.* A follower's open
  descriptor does not survive a module restart. The sequence **backend down → file rotates → module
  restarts** stranded the backlog in an archive nobody follows. Any two of the three were safe; all
  three were not.

  Resolved by **REQ-SH-27**. An external rotator can still cause it, so the limitation is stated in
  the README and pinned by a test that asserts it rather than leaving it to drift.

- **REQ-SH-27** — **Rotation is deferred while unshipped bytes remain** for that file, because
  rotating would strand them if the module then restarted (REQ-SH-21). The deferral is bounded by
  `ship.maxBacklogBytes` (default 256M): past that, rotation proceeds anyway, because filling the
  disk is the worse failure — and the abandoned byte count is logged at error level.

### 5.5 Configuration and operability

- **REQ-SH-22** — Module config plus a watched sidecar file, with the same precedence and reload
  semantics as the other modules. Secrets (`${ENV_VAR}`) interpolated and masked in all output.
- **REQ-SH-23** — Boot-time schema validation naming the offending path.
- **REQ-SH-24** — Never ship its own logs, or it will amplify its own error reporting into a loop.
- **REQ-SH-25** — Expose via `pmx.probe()`: bytes shipped, lines shipped, lag per file (bytes behind
  EOF), rotations performed, delivery failures, bytes dropped to the disk cap.
- **REQ-SH-26** — `lag per file` is the headline number. It is the one figure that tells an operator
  whether shipping is keeping up.

---

## 6. Acceptance criteria

To be exercised by lab scenarios, in the style already established:

1. An app writing 10k lines has all 10k arrive at the backend, in order, with no gaps.
2. Killing the module mid-stream and restarting it produces **no gap** — duplicates are permitted.
3. With the backend refused for 60 s, nothing is lost: shipping resumes from the stored offset.
4. A cluster app with 4 instances rotates correctly: after rotation every worker writes to the new
   file, and `ls` plus `lsof` agree that nothing still holds the old inode.
5. A file rotated while the shipper is stopped is still fully shipped on restart, old inode first.
6. With a 10 MB cap and a 100 MB/min writer, disk usage stays under the cap and the dropped bytes
   are reported.
7. An app with `out_file: /dev/null` is reported as unshippable at boot, not silently skipped.
8. `merge_logs: true` ships app-attributed lines without claiming a `pm_id`.

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Rotation without reopen | Disk fills while files look rotated — the incumbent's worst bug | REQ-SH-09/10, acceptance 4 |
| Offset advanced before delivery | Silent gaps, discovered only when logs are needed | REQ-SH-18/20/21 |
| Unbounded memory under flood | The module takes down the host it protects | REQ-SH-07/17, NFR-1 |
| Disk cap vs. data loss | Either can be the worse failure | REQ-SH-19 makes the trade explicit and loud |
| Windows rename semantics | Silent breakage, as with the incumbent | REQ-SH-13 refuses rather than pretends |

## 8. Open questions

| # | Question | Blocks | Proposed default |
|---|---|---|---|
| ~~Q1~~ | ~~Bus as an opt-in source for `/dev/null` apps?~~ | **Resolved:** no. Such apps are reported as unshippable at boot |
| ~~Q2~~ | ~~Add CloudWatch?~~ | **Resolved:** no. OTLP reaches it through a collector; a native integration means a credential chain and signing per vendor |
| ~~Q3~~ | ~~Multi-line joining?~~ | **Resolved:** no. Per-language heuristics that fail loudly when wrong |
| ~~Q4~~ | ~~Own rotation or defer to system logrotate?~~ | **Resolved:** own it — and actively warn against running both, since only this module calls `reloadLogs` |
