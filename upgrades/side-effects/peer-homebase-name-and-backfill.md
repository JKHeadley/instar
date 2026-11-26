# Side-effects review — peer homebase "🤝 <peer>" name + boot backfill

**Change:** the per-peer homebase topic is now named `🤝 <peer>` (the name the operator agreed
to), with the short fingerprint appended only when two different peers share a display name.
A bounded boot pass (90 s after start, serving-lease holder only, same
`threadline.peerHomebase.enabled` gate) gives already-paired, mutual-verified peers the homebase
they never got, and renames a recorded homebase still carrying the old
`"<peer> · Threadline · <fp6>"` name. An unrecorded topic with the old name is adopted and renamed
instead of duplicated. The awareness card is updated, and existing agents holding the old card
get it swapped in place by the migrator.

**Tier:** 1 — a revert fully undoes it, the feature is gated (dev-gate: live on a development
agent, dark on the fleet), and the only external effect is creating/renaming Telegram topics the
feature already created. Size: ~7 source/test files, ~350 LOC incl. tests. Effort: no spec review
rounds (Tier 1, built on the converged `peer-conversation-homebase-topic` spec), targeted tests.

**Spec:** `docs/specs/peer-conversation-homebase-topic.md` (the naming rule in §2.1; §6 listed
"no backfill" as an accepted limit, which this closes).

## 1. Over-block — what legitimate inputs does this reject?

Nothing. No gate, no refusal, no new authority.

## 2. Under-block — what does it still miss?

- Two peers with the same name AND the same first six fingerprint characters still share a topic
  (unchanged, §6 accepts it).
- The collision check compares against the trust store as it is at that moment. If peer A gets
  `🤝 Echo` and later a second "Echo" pairs, the second gets `🤝 Echo · fp6`; A keeps its
  unsuffixed name. That is fine — the topics differ — but the naming is order-dependent.
- A rename that Telegram refuses is logged and retried at the next boot only.

## 3. Level-of-abstraction fit

Naming, legacy recognition, collision and backfill selection are pure functions in
`src/threadline/peerHomebase.ts` next to the existing decisions; the route and the boot wiring
only inject Telegram and trust-store callbacks. One small read-only helper,
`TelegramAdapter.findTopicIdByName`, avoids reaching into the adapter's private map.

## 4. Signal vs authority

No authority. It creates or renames a topic, which is presentation; it binds no conversation and
moves nothing the operator chose.

## 5. Interactions

- Backfill calls `ensurePeerHomebase`, so it inherits every existing guard: gate, lease holder,
  already-recorded short-circuit, record refuses a different id.
- Bounded to 10 creates + 10 renames per boot; failures are counted and logged, never thrown.
- Runs on a 90 s unref'd timer so it never delays boot and sees a settled lease; `state.readOnly`
  is read at fire time.
- `editForumTopic` updates the adapter's name registry, so a later find-by-name sees the new name.

## 6. External surfaces

Telegram topic names change for the existing homebases (old form → `🤝 <peer>`). New homebase
topics may be created at boot for peers paired before the feature. No route or config change.
The CLAUDE.md card text changes (template + migrator swap).

## 7. Multi-machine posture (Cross-Machine Coherence)

**unified** — only the serving-lease holder creates or renames, exactly as before; the recorded
topic id lives on the trust profile, which replicates under its existing class. A standby does
nothing.

## 8. Rollback

Revert the commit. Renamed topics keep their new names (harmless); the old code finds them by the
recorded id, not by name.

## Second-pass review

Not required (Tier 1, no gate/sentinel/watchdog authority).
