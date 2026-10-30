# pm2-shipper

Log rotation for PM2 that works in cluster mode, with a disk cap that is actually enforced.

```bash
pm2 install pm2-shipper
pm2 set pm2-shipper:maxSize 50M
pm2 set pm2-shipper:maxTotalSize 2G
```

That's it — every app PM2 manages is rotated, compressed, and kept inside the byte budget.

> **Status: rotation only.** Shipping to Grafana Loki and OTLP is the next stage and builds
> on the same file discovery. See [Roadmap](#roadmap).

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

`reopenFailures` is the one to watch. A non-zero value means a rotation left workers writing to
an archive — the failure this module exists to prevent.

---

## Troubleshooting

**Nothing rotates** — check `maxSize` against the live file size, and that the app isn't in
`exclude` or missing from a non-empty `only`. Empty files are never rotated.

**`pm2` commands hang forever** — your `PM2_HOME` path is too long. PM2 binds
`$PM2_HOME/rpc.sock` and Linux caps socket paths at 107 characters; over that the bind fails
silently. Check with `echo -n "$PM2_HOME/rpc.sock" | wc -c`.

## Roadmap

Shipping to **Grafana Loki** and **OTLP** is next, built on the same discovery and on tailing
the files by byte offset rather than subscribing to PM2's bus — the bus is fire-and-forget with
no replay, and this module restarts whenever `pm2 set` changes its own config. Delivery will be
at-least-once: duplicates after a crash are acceptable, gaps are not.

## Development

```bash
npm install && npm run build && npm test
```

## License

MIT
