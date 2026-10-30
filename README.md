# pm2-shipper

Log rotation that works in cluster mode, and log shipping that does not lose lines.

```bash
pm2 install pm2-shipper
pm2 set pm2-shipper:maxSize 50M
pm2 set pm2-shipper:maxTotalSize 2G

# optional: ship to Loki or an OTLP collector
pm2 set pm2-shipper:shipUrl http://loki:3100
pm2 set pm2-shipper:shipEnabled true
```

Every app PM2 manages is rotated, compressed, kept inside a byte budget, and — if you want
it — shipped. Shipping is off by default; with no backend configured this is purely a
rotator.

---

## Why rotating PM2 logs is harder than it looks

Renaming a log file does **not** make PM2 write to a new one.

In cluster mode each **worker** intercepts `process.stdout.write` and writes to the log file
itself — `ProcessContainer.js` holds the descriptor, not the daemon. Rename the file and every
worker keeps appending to the same inode. The file vanishes from `ls` while the disk keeps
filling, which is exactly the shape of the bug people report as "it rotated but the disk still
filled".

This is verified, not inferred. Against a live 2-instance cluster app:

```
rename the log file
  → the renamed inode keeps growing
  → nothing recreates or writes to the original path
  → /proc/<worker-pid>/fd shows the WORKER holding the renamed file

pm2 reloadLogs
  → the new file starts growing
  → the renamed one stops
```

So rotation here is a protocol, in this order:

```
rename  →  pm2 reloadLogs  →  verify the new file exists  →  compress
```

**Compression happens last, and only after the reopen is confirmed.** Compressing a file that
workers may still be appending to produces a truncated archive and a hidden file that keeps
growing. If `reloadLogs` fails or the new file never appears, this module leaves the archive
uncompressed, says so loudly, and retries on the next cycle rather than assuming it worked.

---

## Shipping

Logs are read by **tailing the files**, not by subscribing to PM2's bus. The bus is
fire-and-forget with no replay, and this module restarts whenever `pm2 set` changes its own
configuration — a shipper whose promise is "your logs reach your backend" cannot be built on
a transport that drops them during its own routine restart. A byte offset in a file survives
a restart; a missed bus event is gone.

### Delivery is at-least-once

An offset is committed **only after the backend accepts the batch**. A refused batch rewinds
to the last committed point and is read again next cycle, so the file itself is the buffer.

**Duplicates after a crash are possible; gaps are not** — within the boundary below. That
distinction matters when you write queries: deduplicate on content if you need exactly-once
semantics downstream.

Verified against a live daemon with an app emitting a strict sequence: restarting the
shipper mid-stream and taking the backend offline both produced **zero gaps** across ~670
lines.

### Where the guarantee ends

A follower's open descriptor does not survive a module restart. So if a file is rotated by
**something other than this module** while shipping is behind, and the module then restarts,
the stored offset points at an inode that is no longer at that path and the backlog is
stranded in an archive nobody follows.

This module's own rotation cannot cause it: **rotation is deferred while unshipped bytes
remain.** If the backend stays down, the backlog is allowed to grow to `maxBacklogBytes`
(default 256M), after which rotation proceeds anyway and the abandoned byte count is logged
as an error — filling the disk is the worse failure, but it is never silent.

If you run system `logrotate` against PM2's log directory as well, that is the case to avoid.
Don't — this module already rotates, and only it knows to call `pm2 reloadLogs`.

Both behaviours are pinned by tests, including one that asserts the limitation so it cannot
quietly become something worse.

### Backends

```yaml
ship:
  enabled: true
  backend: loki            # or otlp
  url: http://loki:3100
  headers: { X-Scope-OrgID: tenant-a }
  labels: { env: prod }
  pollSeconds: 2
  maxBatchBytes: 1M
```

**Loki** labels on `app`, `stream` and `host` only. `pm_id` is deliberately *not* a label:
Loki indexes labels, and on a 16-instance cluster it would multiply your stream count by
sixteen for something that belongs in the line.

**OTLP/HTTP** is also the route to CloudWatch, Datadog and most other sinks — the
OpenTelemetry Collector already exports to them, so one hop of standard infrastructure
replaces a native integration and a credential chain per vendor.

### Rotation and shipping cooperate

Because one module owns both, the tail of a file is shipped *before* it is rotated away, and
the follower keeps its descriptor open so it drains the old inode before following the new
file. A rotation loses nothing, whoever performed it.

---

## Configuration

Module config for simple cases, a sidecar file for anything per-app:

```bash
pm2 set pm2-shipper:configFile /etc/pm2-shipper/config.yaml
```

```yaml
checkSeconds: 30

maxSize: 50M            # rotate at this size; 0 disables the size trigger
intervalSeconds: 0      # also rotate on a timer; 0 disables it
compress: true

maxTotalSize: 2G        # TOTAL archive bytes kept per log file
maxArchives: 30         # additional count limit

includeModules: true    # PM2 modules' own logs grow too
exclude: [noisy-debug-app]

apps:
  firehose:             # per-app overrides
    maxSize: 200M
    maxTotalSize: 10G
```

### The cap is a byte budget, not a file count

`maxArchives: 30` does not bound disk usage. Thirty archives of a gigabyte each satisfy it
perfectly while filling the disk — which is how a log rotator ends up causing the outage it was
installed to prevent. `maxTotalSize` is the limit that actually binds; the count is an extra
constraint, never the only one.

When the cap forces a deletion, it is logged with the byte count. Deleting logs is a real loss.
It beats filling the disk, but it is never silent.

### Size is measured, not counted

`maxSize` is checked against the file's **actual size on disk** every cycle. A running byte
counter drifts whenever anything else writes to the file or the module restarts, and
"`max_size` is ignored" is the most common complaint about the module this replaces.

---

## Apps that cannot be rotated

An app with `disable_logs: true`, or an out/err path pointing at `/dev/null`, has no file to
rotate. This module **reports those at boot** rather than passing over them:

```
WARN app cannot be rotated  app=api  reason=out log is sent to a null device, so there is no file
```

An operator who believes an app is covered when it is not is worse off than one who knows.

## Windows

`rename` fails on a file that is held open on Windows, so the default strategy there is
**refuse**, with an explanation. Set `strategy: copy-truncate` to rotate anyway, accepting that
lines written between the copy and the truncate are lost.

Silent Windows breakage is a documented failure of the incumbent module. This one would rather
tell you it cannot do the job.

## Metrics

Exposed through `@pm2/io` when present, so `pm2 monit` shows whether it is working:
rotations, reopen failures, archives compressed and deleted, bytes rotated and freed, bytes
dropped to the cap, and apps that cannot be rotated.

`reopenFailures` is the one to watch for rotation: a non-zero value means a rotation left
workers writing to an archive. For shipping it is `shippingLagBytes`, the number of bytes
behind the end of the files being followed — the one figure that says whether delivery is
keeping up.

---

## Troubleshooting

**Nothing rotates** — check `maxSize` against the live file size, and that the app isn't in
`exclude` or missing from a non-empty `only`. Empty files are never rotated.

**`pm2` commands hang forever** — your `PM2_HOME` path is too long. PM2 binds
`$PM2_HOME/rpc.sock` and Linux caps socket paths at 107 characters; over that the bind fails
silently. Check with `echo -n "$PM2_HOME/rpc.sock" | wc -c`.

## Roadmap

Elasticsearch, CloudWatch and syslog outputs if demand appears — OTLP already reaches most of
them through a collector. Multi-line stack-trace joining is deliberately absent: it needs
per-language heuristics and fails loudly when it guesses wrong.

## Design documentation

- [`docs/requirements.md`](./docs/requirements.md) — what this was built against, including the
  durability boundary found by testing after the claim had already been written down.
- Platform findings (F1–F13) live in **`pm2-ops-contract`**.

## Requirements

Node 18 or newer — tested on 18, 20, 22, 24 and 26 — with PM2 5 or newer.

## Development

```bash
npm install && npm run build && npm test
```

## License

MIT
