# Side-Effects Review — The dashboard PIN goes to the owner privately, never to a group

**Version / slug:** `identity-security-piece1d-pin-private`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. Spec `docs/specs/identity-security-piece1d-pin-private.md` (3 rounds).

- **The send.** `DashboardPinPrivate` (`src/server/dashboardPinPrivate.ts`) sends this machine's PIN to the configured owner's private chat:
  - once per machine and PIN generation;
  - whenever the owner or an agent asks, with a repeat within 5 minutes answered as "sent a moment ago";
  - the record is written only when Telegram accepts the send, and holds the generation id, never the PIN.
- **The route.** `POST /dashboard/pin/send-private` sits behind the auth middleware, is capped at 3 per PIN generation an hour, and answers an outcome, never the PIN.
- **The triggers.** The configured owner's own private message, from the server's poller or the lifeline forward, resumes a pending delivery. "fix dashboard", the broadcast and the route also send.
- **`TelegramAdapter.sendOwnerSecret`** uses a new protected notification category, `owner-secret`:
  - the gate always delivers it, and a gate error stores a placeholder instead of the text;
  - `apiCall` refuses an `owner-secret` send to any destination other than the owner's private chat;
  - it is stamped in one place.
- **The pinned Dashboard message.** The private delivery runs first. Digits appear only on a definite "no private route" (no owner, or a 403), on the polling machine, with no paired owner phone. Otherwise the message says "sent to you privately" or "ask me in your private chat".
- **"fix dashboard"** sends privately, and its group reply carries no digits.
- **Tunnel notices.** Both tunnel notices that carry the PIN move to the secret send.
- **Coherence report.** It no longer records the generated digits.
- **Upgrade prompt.** The dormant upgrade prompt no longer includes the PIN.
- **Instructions.** The stock PIN-sharing sentences are rewritten in the templates and the migrator text. A migration rewrites them in existing agents' `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and reference files, from one phrase table (`src/core/pinDisclosureText.ts`).

## Decision-point inventory

- Pinned Dashboard message PIN line — modify — digits only on a definite "no private route" with no other way in.
- Quiet gate decide — add — `owner-secret` is always delivered.
- Telegram `apiCall` — add — the `owner-secret` destination check.

---

## 1. Over-block

No way in is removed. The owner keeps the group digits when there is no private route at all, the phone console when a phone is paired, and the private chat otherwise. A standby's group message no longer shows its PIN, and the owner gets it privately from that machine instead.

## 2. Under-block

The PIN still reaches the owner's private chat. Removing it from every chat is piece 4. PINs already posted stay in history.

## 3. Level-of-abstraction fit

There is one delivery module and one secret send. The secret category follows the `owner-decision` precedent, and the instruction rewrite is one table used by both the templates and the migration.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface for callers (it moves where a message goes; the `owner-secret` destination check is a deterministic recipient rule).
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

Once per generation, the 5-minute repeat window and the hourly cap of 3 are bounded deterministic rules, with their basis in the spec.

## 4c. Self-action convergence

There is no self-triggered loop. Delivery runs only on a trigger: the owner's message, a request, a broadcast or "fix dashboard". A `held` outcome waits for the next trigger.

## 5. Interactions

- **Quiet gate:** `owner-secret` is protected, so it is never quiet-recorded.
- **Raw-send baseline:** one entry is added, `sendOwnerSecret`, as for `sendOfferList`.
- **Origin layer:** it refuses identical content while an earlier send is unresolved, so each message carries its send time.
- **Outbound dedup gate:** it refuses near-identical messages within 5 minutes, so a repeat is answered "sent a moment ago".
- **Broadcast:** the private send runs before the group edit and never throws (bounded at 10 s). `getMe` is called only when the delivery is wired.
- **Broadcasts are serialized:** the refresh after a delivery waits for a broadcast already running, so a first broadcast never posts two pinned messages.
- **PIN and generation are read live** through LiveConfig, so a rotation or a PIN made by "fix dashboard" is a new generation at once.
- **Migration order:** the instruction rewrite runs before `migrateClaudeMd` reads `CLAUDE.md`, and again after it (idempotent), so later writes in the same run carry it.
- **The origin layer's outbox** keeps the private message text until the send is resolved, machine-local and outside backups and git. That is the same as today's `sendToOwnerDM`.

## 6. External surfaces

- The owner gets a private message with their PIN, once per PIN.
- The pinned Dashboard message text changes.
- The "fix dashboard" reply changes.
- There is a new route, plus an awareness entry.

## 6b. Operator-surface quality

The group line names what to do ("open a private chat with me (t.me/<bot>) and say hi"). The private message names the agent, the machine and the link.

## 7. Multi-machine posture

- **Records:** they are keyed by machine and PIN generation, and each message names its machine.
- **Standbys:** they never show digits, and send privately at their own triggers.
- **The polling machine:** only it sees the owner's private message.

## 8. Rollback cost

Revert and ship a patch. An older build re-edits the pinned message with the digits on its next refresh, which is today's status quo. The state file `state/dashboard-pin-private.json` is ignored by older builds.

## Conclusion

Clear to ship once the second pass concurs.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5), 2026-11-18
**Independent read of the artifact: concur**

I re-checked both blocking defects after the fixes. `migrate()` now runs `rewritePinDisclosureInstructions` before `migrateClaudeMd` reads CLAUDE.md, so the later writes carry the rewrite. `DashboardPinPrivate` reads the PIN and its generation live from LiveConfig, so a rotation, a PIN created by "fix dashboard" or the coherence self-correct counts as a new generation at once. The smaller points are also handled: broadcasts are serialized with no deadlock (the refresh after a delivery runs detached), the route cap is per PIN generation, underscores are escaped, and the awareness and section 5 wording is accurate. I still found no path where the PIN reaches a group, a log, a served file or the quiet store, and no lockout on the polling machine.

## Evidence pointers

- **Unit:**
  - New: `tests/unit/identity-piece1d-pin-private.test.ts` (outcomes, records, the repeat window, the owner-only trigger, group message modes, instruction rewrites, the protected category, the single stamp).
  - Existing suites that pass: dashboard pin-leak and edit-rejection, notification selectivity and the owner-decision category, the tunnel suites, and the seed migration.
- **Guards:** no-silent-fallbacks, feature-ladders, awareness, html-site, the 21 ratchet files and the notification-selectivity lint all pass.
- **Throwaway:** agent home `.instar/state/identity-build-144636/p1d-throwaway-proof.md`. It covered the route before a private chat existed, the owner's first message delivering, no repeat, "fix dashboard" private, the rate cap, and no digits in state. Telegram's API was answered by a shim.
