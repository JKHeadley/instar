# Side-Effects Review — Canonicalize peer address to full fingerprint on send

**Version / slug:** `threadline-canonicalize-peer-address`
**Date:** `2026-06-04`
**Author:** `Echo (instar dev agent)`
**Tier:** `1 (targeted bug fix to existing route + tests; no new surface, no schema change)`
**Second-pass reviewer:** `recommended — SHARED Threadline security code (Dawn runs it too). PR is opened for Dawn's review before merge; NOT self-merged.`

## Summary of the change

`/threadline/relay-send` resolves a peer's **full fingerprint** for routing
(`resolvedId` on the relay path; `localTarget.fingerprint` on the local path),
but `captureOrigin` stored the raw caller-supplied target (which may be a
`name:fpPrefix` composite like `Dawn-Workstation:8c7928aa`) as the conversation's
`remoteAgent`. The inbound anti-hijack guard (`ThreadlineRouter`) compares a
reply's `senderFingerprint` (the bare full fingerprint, often with empty
`senderName`) against the stored `remoteAgent`; a composite/display string never
equals a bare fingerprint, so a known peer's reply was false-isolated to a fresh
cold-spawn thread — breaking A2A continuity (the "one coherent individual"
property). Observed live as the 2026-06-04 Dawn cold-spawn incident.

Fix: `captureOrigin(effThreadId, canonicalRemoteAgent, displayName?)` now stores
the **resolved full fingerprint** as `remoteAgent` and keeps the raw target only
as `remoteAgentDisplayName`. The two call-sites pass the already-resolved
fingerprint (relay: `resolvedId`; local: `localTarget.fingerprint ||
publicKey.slice(0,32) || name`). Mirrors `telegramBridge.mirrorOutbound`, which
already stored `{ remoteAgent: resolvedId, remoteAgentName: targetAgent }`.

Files: `src/server/routes.ts` (captureOrigin signature + 2 call-sites),
`tests/unit/ThreadlineRouter-anti-hijack.test.ts` (+2 guard tests),
`tests/integration/threadline/relay-send-canonical-remoteagent.test.ts` (new).

## 1. Over-block / weakening

Does it weaken the guard? No. We only ever store the **full** fingerprint the
server itself resolved for routing — never a guessed value and never an
8-char prefix (prefix-matching would be a ~32-bit, grind-able hijack vector and
is explicitly NOT used). An impostor presenting a different fingerprint still
fails `peer === inboundFp` and is still isolated (proved by the retained
"isolates an unverified sender" test + the new composite-isolation test). The
change strictly *adds* correct matches for a genuinely-resolved peer; it removes
no isolation.

## 2. Under-block

Does it miss a case it should catch? No new bypass: the stored owner is now a
stronger identity (full fingerprint) than before (a spoofable display string).
Existing threads already persisted with a composite owner are NOT retroactively
rewritten — this is a forward fix at the write path; the one historically-broken
thread is a one-off. The deeper R2 question (relay inbound `trust.kind` is
hardcoded `plaintext-tofu`, so a verified peer is never crypto-exempted) is
intentionally OUT OF SCOPE here and left for security-design review.

## 3. Level-of-abstraction fit

The canonicalization lives at the send/record boundary (`captureOrigin`), the
same place that already owns the resolved-fingerprint vs display-name split for
the Telegram mirror. The guard is untouched (no change to ThreadlineRouter).

## 4. Signal vs authority compliance

No gate/authority change. `remoteAgentDisplayName` preserves the human-facing
label for all display strings (`captureOriginOnSend` already falls back to
`remoteAgentDisplayName ?? remoteAgent`).

## 5. Interactions

- The anti-hijack guard now matches a known peer's bare-fingerprint reply
  (`peer === inboundFp`) and resumes instead of cold-spawning.
- `appendCanonicalOutboxEntry` and `mirrorOutbound` already used `resolvedId`;
  this aligns `captureOrigin` with them (consistency, not a new direction).
- `captureOrigin` only fires when `originTopicId` is set (origin capture);
  topic-less sends are unaffected (their owner is written by the inbound handler
  as `message.from.agent = senderFingerprint`, already a full fingerprint).

## 6. External surfaces

No new HTTP route, no config, no template/CLAUDE.md change, no persisted-format
change (the `remoteAgent` field already existed; only the VALUE stored is now the
canonical fingerprint). Nothing to migrate.

## 7. Rollback cost

Low — revert one function signature + two call-sites + two test files. No
data-format change; existing records are untouched.

## Conclusion

Low-risk, strictly non-weakening, additive correctness fix at the send/record
boundary that closes the composite-address false-isolation (the Dawn cold-spawn
incident). Guard unchanged; impostors still isolated; only genuinely-resolved
peers now resume. Shipped behind a PR for Dawn's review (shared security code);
the deeper R2 trust-propagation question is logged separately, not touched here.
