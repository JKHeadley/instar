# Side-Effects Review — Threadline Canonical Inbox Write at Relay-Ingest

**Version / slug:** `threadline-canonical-inbox-write`
**Date:** `2026-05-02`
**Author:** `echo`
**Second-pass reviewer:** `self (incident-grounded reasoning)`

## Summary of the change

The threadline relay handler in `src/commands/server.ts` (`gate-passed`
event listener) had three routing branches — pipe-mode (`PipeSessionSpawner`),
warm-listener (`ListenerSessionManager.writeToInbox`), and cold-spawn
(`ThreadlineRouter.handleInboundMessage`). Only the warm-listener branch
wrote to a per-rotation queue file (`state/listener-inbox-{rotation}.jsonl`);
none of the three branches wrote to the **canonical** threadline inbox at
`.instar/threadline/inbox.jsonl.active`. As a result the canonical inbox
file was frozen since 2026-04-05, hiding ~4 weeks of inbound traffic from
the dashboard, observability, and any consumer that reads the canonical
file (e.g. the planned threadline → telegram bridge).

This change adds a single canonical-inbox append at relay-ingest, BEFORE
the pipe / listener / cold-spawn branching, so all three paths agree on
one source of truth. The hoist runs through a new
`ListenerSessionManager.appendCanonicalInboxEntry()` helper that writes
HMAC-signed entries to `threadline/inbox.jsonl.active` using the same
HKDF-derived signing key the daemon and warm-listener already share —
no key divergence, no ambient-key footgun.

Files modified:

- `src/threadline/ListenerSessionManager.ts` — adds
  `canonicalInboxPath` getter and `appendCanonicalInboxEntry(opts)` method.
  The new method writes to the canonical inbox path; it does NOT write
  the wake sentinel (the warm-listener queue and its sentinel remain a
  separate, listener-only concern).
- `src/commands/server.ts` — in the `gate-passed` event handler, after
  auto-ack and BEFORE the pipe / listener / cold-spawn branching, calls
  `listenerManager.appendCanonicalInboxEntry({ ... })` once. Wrapped in
  try/catch with a non-fatal warn — routing continues even if the
  canonical append fails, preserving message liveness over auditability.

Tests added: 6 new unit cases in
`tests/unit/ListenerSessionManager.test.ts > canonical inbox`:

1. `canonicalInboxPath` getter returns `threadline/inbox.jsonl.active`
2. `appendCanonicalInboxEntry` creates the directory on first write and
   appends a parseable JSON line with the right fields
3. The HMAC of a canonical entry round-trips through the existing
   `verifyEntry()` — proves daemon/listener/relay share one signing key
4. Multiple appends produce multiple lines in chronological order
5. An optional caller-supplied `messageId` is honored as the entry id
6. The canonical inbox file is created with `0o600` permissions

Local result: 45/46 pass; the 1 failing case
(`state management > starts in dead state`) is a pre-existing failure
documented in prior `instar-dev` traces (e.g.
`2026-04-27T15-50-00Z-telegram-delivery-robustness-layer-3.json`) and
unrelated to this change.

## Decision-point inventory

- `ListenerSessionManager.appendCanonicalInboxEntry` — **add** — pure
  canonical-inbox append, no wake sentinel.
- `ListenerSessionManager.canonicalInboxPath` — **add** — getter for the
  canonical inbox path, kept side-by-side with `inboxPath` (warm-listener
  queue) so the two roles are visibly distinct in the API surface.
- `gate-passed` handler in `server.ts` — **modify** — runs canonical
  append once, before any branching. No change to pipe-mode, warm-listener,
  or cold-spawn routing decisions or behavior.
- HMAC key — **pass-through** — the new helper uses the same HKDF-derived
  signing key (`info: 'instar-inbox-signing'`) that
  `writeToInbox` and the listener daemon already use; no new key, no new
  derivation parameter.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. The hoist is a relay (write-only), not a gate. It does not block,
delay, or filter messages. Routing decisions — pipe vs warm vs cold-spawn —
are unchanged. Auto-ack timing is unchanged. The canonical write happens
synchronously in the same event handler, on the same Node.js event loop,
adding a single `appendFileSync` call — no I/O contention with the routing
branches that follow.

The append is wrapped in try/catch with a non-fatal warning. If the
canonical write fails (disk full, permission error, etc.), the message
still routes through pipe / listener / cold-spawn as it does today.
Liveness is preserved over auditability when those two are in tension.

## 2. Under-block

**What failure modes does this still miss?**

- **Failure-open on canonical-inbox write.** A disk error during
  `appendFileSync` produces a single warn line and the message routes
  normally. The canonical inbox loses that entry. Acceptable: the same
  behavior is already in place for the warm-listener `writeToInbox` and
  for the daemon's `writeInboxEntry` — none of them block routing on
  inbox-write failure. The canonical inbox is an audit / observability
  surface, not a gate.
- **Pre-existing freeze (Apr 5 → May 1).** Backfilling the missing
  ~4 weeks of inbound messages is OUT OF SCOPE for this PR — that's
  deliverable (c) in the topic-8686 build (separate PR, separate review).
  This PR fixes the write-path going forward; (c) reconstructs the
  history from spawn-session transcripts and the thread-resume map.
- **Listener daemon path (`listener-daemon.ts`) still bypasses this code
  path.** The daemon connects to the relay independently and has its own
  `writeInboxEntry` that already targets the canonical file. This PR
  does NOT alter the daemon. When the daemon is the active relay
  consumer, it continues to write canonically as it does today; when the
  in-process relay client (server.ts handler) is the consumer, the new
  hoist takes care of canonical writes. Both paths converge on the same
  file with the same HMAC key.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The relay handler is the natural choke point: it is the single
function in the in-process relay consumer that sees every inbound
message exactly once before any routing decision. Doing the canonical
write here — rather than inside each routing branch — is the
single-source-of-truth pattern the spec calls for.

The helper lives on `ListenerSessionManager` because that class already
owns the HMAC key derivation and the existing `writeToInbox` + `verifyEntry`
methods. Adding a sibling method that targets the canonical path keeps
the key derivation, HMAC computation, and entry shape in one place.
A future refactor could extract a separate `CanonicalInboxWriter` class,
but the cost-of-now (one new method, ~30 LoC, one new getter) is lower
than the cost-of-extraction (new class, dependency wiring, test scaffolding).

## 4. Signal-vs-authority compliance

**Where is the signal? Where is the authority?**

- **Signal:** the inbound `gate-passed` event itself, which has already
  been authorized by `InboundMessageGate`. The canonical append is a
  pure observation of that signal — write-once, append-only, no decision
  surface.
- **Authority:** unchanged. The pipe / warm-listener / cold-spawn
  routing decision still lives in `server.ts` (and downstream in
  `PipeSessionSpawner.shouldUsePipeMode`, `ListenerSessionManager.shouldUseListener`,
  `ThreadlineRouter.handleInboundMessage`). The canonical inbox does not
  gate, throttle, or veto routing.

The split passes the signal-vs-authority memory test: a brittle/low-context
write path (the canonical append) emits a signal; the higher-level
intelligent gate (already-existing `InboundMessageGate` upstream of the
`gate-passed` event) holds the blocking authority.

## 5. Interactions

**What other systems does this touch?**

- **Warm-listener queue (`state/listener-inbox-{rotation}.jsonl`).** No
  change. The warm-listener path still calls `writeToInbox` which writes
  to the rotated per-listener file AND the wake sentinel. Both files
  coexist: canonical = audit/observability/bridge source; rotated =
  warm-listener queue.
- **Listener daemon (`listener-daemon.ts`).** No change. The daemon's
  `writeInboxEntry` already targets the canonical file. After this PR,
  there are exactly two writers to the canonical file — the daemon (for
  the standalone-listener mode) and the in-process relay handler (for
  the in-server mode). They are mutually exclusive at runtime: only one
  is the active relay consumer at a time.
- **Threadline → Telegram bridge (deliverable b, future PR).** This PR
  is a precondition. The bridge reads the canonical inbox to know which
  messages to mirror into Telegram; without this fix, the bridge would
  see no traffic on the cold-spawn or pipe paths. After this PR the
  bridge has a complete signal stream.
- **Dashboard observability tab (deliverable 4, future PR).** Same: the
  observability tab reads the canonical inbox and the thread-resume map.
  This PR ensures the canonical inbox is actually populated.

## 6. Rollback cost

**How easy is it to undo this if it breaks something in production?**

Trivially easy. The change is two surgical additions:

1. A new method + getter on `ListenerSessionManager` (no callers in
   tests or production reference it except the new test file and the
   new `server.ts` call site).
2. A 13-line block in `server.ts` that is fully wrapped in `if (listenerManager)`
   and `try/catch`. Removing that block restores the prior behavior
   exactly.

No schema migrations, no new file format, no new key material, no
dashboard changes. The canonical inbox file is append-only JSONL — if a
subsequent change wants to drop the entries, `rm` the file (or rotate
it). No referential integrity to unwind.

## Plan if a regression appears

- **Symptom: routing latency increases.** Profile the `appendFileSync`
  call. The canonical inbox is local-filesystem JSONL; on macOS APFS
  / ext4 / xfs the syscall is sub-millisecond. If unexpectedly slow,
  hoist into a `setImmediate` so the routing branches run first.
- **Symptom: canonical inbox file grows unboundedly.** Same growth rate
  as the warm-listener queue's rotation cycle — so we already know the
  steady-state. If growth is a problem, add a rotation policy mirroring
  the listener's (compaction at N messages, archive on rotation).
- **Symptom: HMAC verification fails for canonical entries.** The signing
  key comes from the same HKDF derivation as `writeToInbox` and
  `loadSigningKey` — verified by the round-trip unit test. If a real
  failure shows up, look for an authToken mismatch between processes.

## Phase / scope

This is the FIRST of five deliverables in topic-8686 (Threadline → Telegram
Bridge). Subsequent deliverables — dashboard settings, bridge module,
observability tab, and four-thread backfill — depend on this canonical
write-path being live. Each will ship as its own PR with its own
side-effects review.
