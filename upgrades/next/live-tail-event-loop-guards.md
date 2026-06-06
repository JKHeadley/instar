---
bump: patch
---

## What Changed

The multi-machine live-tail streamer (the lease holder pushing recent conversation
content to the standby every 5s) rebuilt EVERY known topic's content on EVERY tick —
and the Telegram content provider resolved each rebuild by synchronously reading the
entire JSONL message log (up to 75,000 lines) per topic. On 2026-06-05 this blocked
the live echo server's event loop for 5–40s at a stretch (151 measured gaps >5s in
10 minutes), which made outgoing mesh RPC timestamps stale, which made the standby
reject flushes (403), which the source hot-retried every tick — a self-amplifying
storm that read as "machine under extremely heavy load" and stuck Telegram delivery.
Four bounded mechanisms close it: (1) a per-topic monotonic content version in
`TelegramAdapter` lets `LiveTailSource` skip unchanged topics without building their
content; (2) `getTopicHistory` is served from an in-memory per-topic tail cache
(single-pass batch seed for all live topics, maintained on append, byte-equivalent
to a file scan — the handoff hash depends on that and it is test-pinned); (3) a
failed flush backs off exponentially (5s base doubling to a 5min cap) instead of
retrying at tick rate, while the handoff path explicitly forces past gate+backoff;
(4) a single flush's content is capped at 256KiB (matching the standby buffer's
own per-topic ceiling).

## What to Tell Your User

If you run me on more than one machine: my server no longer freezes for seconds at
a time while keeping the other machine's copy of our conversations fresh, and the
two machines no longer talk themselves into retry storms when one of them stalls.
Messages stop getting stuck, and false "the other machine looks dead" machine-swaps
stop being triggered. Nothing about what the standby machine knows changes — it
just costs almost nothing to keep it current now.

## Summary of New Capabilities

- Live-tail version gate: idle topics cost one Map lookup per tick instead of a
  full message-log read (TelegramAdapter.getTopicContentVersion → LiveTailSource).
- Topic tail cache: getTopicHistory serves from memory after a one-time single-pass
  seed — no per-call file reads (also speeds respawn history + handoff hashing).
- Flush failure backoff: a rejecting/unreachable standby is retried on an
  exponential schedule (5s→5min), never hammered at tick rate; handoffs bypass it.
- Flush content cap: one flush ≤256KiB (freshest suffix kept) — matching what the
  standby retains anyway.

## Evidence

Live incident 2026-06-05 (topic "Resource Limitation Mitigation"): event loop gaps
measured via server.log timestamp deltas (151 gaps >5s in ~10min); `sample` traces
showed timer callbacks in giant live-tail payload serialization; Mini rejected
flushes `stale-timestamp` / live-tail flush 403s with "flush seq=1 not acknowledged
— will retry" + "content diverged — resending full tail" hot loops. Root cause in
code: `LiveTailSource.pushTick` → `getTopicContent` per topic per tick →
`TelegramAdapter.getTopicHistory` full `readFileSync` of the 75k-line JSONL per
call. Spec: `docs/specs/live-tail-event-loop-guards.md`. Tests: 32 green across
`LiveTailSource.test.ts` (gate/backoff/cap/force + all pre-existing delta pins),
`TelegramAdapter-topicTailCache.test.ts` (read-count spy pins + cache-vs-file byte
parity), `live-tail-version-gate-wiring.test.ts` (wiring integrity), updated
`handoff-sentinel-boot-wiring.test.ts` (force pin); tsc + full lint chain clean.
