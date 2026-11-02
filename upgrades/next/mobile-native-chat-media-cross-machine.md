## What Changed

⚗️ Experimental, development agents only (`mobilePairing.native.media.enabled`; dark on the fleet). Files sent in app conversations now reach every one of the agent's machines. Each machine copies every file that a message it holds refers to, over the existing signed machine-to-machine channel (a new `app-media-pull` verb), at most 1 MiB at a time, and keeps a copy only when its length and SHA-256 match the message. Copying runs in the background at a bounded pace (at most 8 slices every 5 seconds), pauses below the free-disk floor and, for at most an hour at a time, while the machine reports itself overloaded. Brakes: a file no machine can provide is retried with a growing wait (30 seconds up to an hour) and given up after 7 days with one notice; a machine whose copies keep failing verification is skipped for 15 minutes, and for the rest of the day after the third time, with one notice. Each machine lists the files it holds every hour; `singleCopyBlobs` counts files only this machine holds, and a file left on one machine raises one notice after the other machines were asked to copy it and still have not. A download of a file still copying answers `202 fetching`; a message whose file has not reached the delivering machine within 60 seconds is delivered with `[file still copying: <name>]`, followed by one `[file now available: <path>]` line when it lands. `GET /health?scope=pool` shows every machine's `appMedia`.

## What to Tell Your User

Nothing yet: this ships dark and needs the next iPhone app build. On a development agent with more than one machine, a file you send in the app is copied to my other machines, so any of them can open it.

## Summary of New Capabilities

- Mesh verb `app-media-pull` (slice, inventory, nudge), registered-peer read class.
- `GET /mobile/media/:sha256?ref=` answers `202 {state: "fetching", retryAfterMs}` while a file is copied here.
- `GET /app/media-path/:attachmentId` pulls a missing file for up to 30 seconds and says plainly why when it cannot.
- Authenticated `/health` → `appMedia.singleCopyBlobs` and `unrecoverableBlobs` are measured (null when they cannot be); `?scope=pool` adds `appMediaPool`.

## Evidence

Unit tests for the serve side, verified pulls, backoff, the 7-day give-up, the peer breaker, the load and disk pauses, inventories and the single-copy alarm ladder; integration tests over a real signed MeshRpc client and dispatcher (202 then the verified bytes, a corrupted slice never kept, "still copying" then exactly one "now available" line, app-media-path pulling on demand, the pool health read); an end-to-end test of two production-booted servers copying a photo between them.
