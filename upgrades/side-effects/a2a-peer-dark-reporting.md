# Side-Effects Review — A2A dark peers: honest sender-side reporting of a send that stays queued

**Version / slug:** `a2a-peer-dark-reporting`
**Date:** `2026-10-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-single-agent-identity.md §3 (converged 2026-10-09, approved by Justin — Telegram topic 9210; CMT-706, autonomous run run-mv181ge1-8af47048). This artifact covers §3 ONLY; §1, §2, §4 and §5 are built by sibling worktrees.

## Summary of the change

Before: a message to a peer that was offline — or listening under a different address — came back `relayStatus: queued`, the relay silently expired it a day later, and nothing on the sender's side ever said "nothing has come back from this peer for hours". The per-message `A2ARedeliverySentinel` (ships off) escalated with a fresh item id per sweep, had no resolve path and no cooldown.

Now (files: `src/threadline/peerDark.ts` NEW, `src/threadline/A2ADeliveryTracker.ts`, `src/threadline/client/ThreadlineClient.ts`, `src/monitoring/A2ARedeliverySentinel.ts`, `src/server/routes.ts`, `src/commands/server.ts`, `src/threadline/ThreadlineMCPServer.ts`, `src/threadline/mcp-http-client.ts`, `src/core/types.ts`, `src/config/ConfigDefaults.ts`, `src/core/devGatedFeatures.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`):

- **Classification (§3.1).** `peerHealth()` gains `dark`, `darkSince`, `queuedCount`, `queuedExpiresAt`, `lastDeliveredAt`. The unanswered set is rows queued at the relay (`awaiting-ack` + relay `queued`), `unconfirmed`, `escalated` (not delivered), or `failed`+`expired`, sent AFTER the last ack / inbound from that peer; the peer is `dark` when the oldest such row is older than `queuedDarkAfterMs` (2 h by default; `perPeer` sets it for one peer by fingerprint, same 5-min floor). Relay expiry never clears it (an expired row stays in the set), and a relay `delivered` verdict ALONE never clears it either: it shows only that a connection under the peer's fingerprint took the message, which a split or a non-serving holder also produces. `lastDeliveredAt` stays on the read as information. `allPeerHealth` is bounded to peers active in the last 30 days. The silence sweep gains one retention statement (rows with `sent_at` older than 30 days in every state) and `findOverdue` is bounded to the oldest 500.
- **Presence (§3.2).** `presence-change` frames now feed the same `knownAgents` map `discover-result` fills (merge, never strip keys); `peerConnectedNow(fp)` answers `true`/`false` from a fresh row and `null` when there is no row, my relay is not connected, or no frame arrived in the last 15 min. `peerPresence(fp)` is the full read behind it: `connectedNowReason` (`no-row` / `relay-down` / `stale`) says why a `null` is null, and `connectedAsOf` is when that peer's own row was written. `refreshPresence()` is one discover; a rejected call answers `false` and leaves the map untouched.
- **Send response (§3.2).** `POST /threadline/relay-send` (and `threadline_send`, additively) carries `peerDark: {since, queuedCount, expiresAt, connectedNow, connectedNowReason, connectedAsOf}` on a send to a dark peer, computed from THIS machine's ledger + presence map (never a peer fan-out, never an inline discover). `queuedCount` counts this send only when its own verdict was `queued`. With the notice on and `dryRun: false` the `deliveryOutcome` is the sentence worded to the evidence; in dry-run the legacy sentence stands and a `would-sentence` row is recorded. A standby's send is forwarded, so the relay holder computes the field and the forward answer transcribes it.
- **Health reads (§3.2).** `GET /threadline/peers/health` (+ per-peer, + pool) carry `dark`, `darkSince`, `queuedCount`, `connectedNow`, `connectedNowReason`, `connectedAsOf`, plus `darkCount` on the list. With no relay client (a standby, relay off) the reason is `relay-down`: my side, not the peer's.
- **Sentinel rework (§3.2 iii–iv, §3.3).** `A2ARedeliverySentinel` is constructed when EITHER `monitoring.a2aRedelivery.enabled` OR the resolved `threadline.peerDarkNotice` gate is on (`redeliver` only under the former). Under the new gate the operator notice is per peer: trigger `dark && queuedCount > 0 && selfHealExhausted`, `dark` for the raise computed over pool-scope acks/inbounds (a `delivered` verdict alone neither clears the raise nor resolves the item) and the peer's own threshold; deterministic id `a2a-peer-dark:<agent>:<peerFp>` (reopened via `upsertAttentionItem`, never a stamped id); resolve on every machine over its own item store from pool-scope life newer than the raise, with the expired-unacknowledged count in the line; 12 h per-peer cooldown (in-process + the durable item's last update, restart-safe). Self-heal BEFORE notify, awake machine only: reconnect a dropped relay, one discover, the §2 self-check (`identitySelfCheck` dep, `unknown` until §2 wires it), two passes 40 s apart. My relay not connected → ONE aggregated item (`a2a-relay-unreachable:<agent>`), per-peer suppressed. The legacy per-message escalation item is raised ONLY when the new gate is off (today's behaviour byte-identical when dark).
- **Rollout (§3.4).** `threadline.peerDarkNotice: {dryRun: true, queuedDarkAfterMs: 7200000, cooldownMs: 43200000}` (plus an optional `perPeer` map, absent by default), `enabled` omitted (dev gate; `DEV_GATED_FEATURES` entry `a2aPeerDarkNotice`), delivered by the `ConfigDefaults` deep-merge. Dry-run rows → `logs/a2a-peer-dark.jsonl`. CLAUDE.md section "A2A dark peers (did my message arrive?)" in the template + `migrateClaudeMd` + the framework shadow list.

## Decision-point inventory

- Per-peer `dark` classification (`A2ADeliveryTracker.peerHealth`) — **add** — invariant: a time threshold over ledger rows; signal-only.
- `peerDark` + the worded `deliveryOutcome` on a send (`routes.ts` relay-send) — **add** — a read on the response; the send itself is already submitted; the sentence rides the dry-run flag.
- `connectedNow` (`ThreadlineClient.peerConnectedNow`) — **add** — invariant: a fresh presence row or `null`; never an inline discover.
- The per-peer raise / resolve / cooldown / aggregate (`A2ARedeliverySentinel`) — **modify** — raise iff `dark && queuedCount>0 && selfHealExhausted` over pool-scope evidence; signal into the Attention queue.
- The self-heal (`reconnectRelay` / `refreshPresence` / self-check) — **add** — awake-only; the reconnect is the existing idempotent re-arm.
- Sentinel construction rule (`server.ts`) — **modify** — either gate constructs; `redeliver` only under the legacy gate.
- Legacy per-message escalation item — **modify** — raised only when the peer-dark gate is off.
- Retention delete + `findOverdue` bound (`sweepSilence`, `findOverdue`) — **add** — invariant: `sent_at` older than 30 days; oldest 500.

---

## 1. Over-block

No send is ever blocked. The only "rejections" are what the notice declines to SAY:

- A peer whose only unanswered rows are `delivered`-but-unacked (the peer's relay connection took them; silence, not darkness) never reads `dark`. A peer that reads everything and never replies therefore stays `stale` (6 h) but not `dark` — by design: `dark` is the offline / wrong-address proxy.
- A peer that is genuinely offline for less than 2 h is not reported. The threshold is config (floor 5 min), and can be set lower for one peer (`perPeer`) when a pair normally answers in minutes.
- A peer that comes back and takes its queued messages or a new one (`delivered`) but has not yet acknowledged or replied still reads `dark` until it does. That is deliberate: `delivered` cannot tell the real peer from another holder of its address. Cost: a returning peer that never acks stays dark until its first inbound; an ack-capable peer clears within seconds.
- A peer that goes dark again INSIDE the 12 h cooldown is reported only when the cooldown lapses (stated accepted cost); the health fields show it immediately.
- A standby raises nothing even for a peer it alone has rows for; the awake machine's own rows or a later send from the awake machine carry the episode. A conversation whose only queued rows live on a standby is reported only once the awake machine also has queued rows to it (bounded by the spec's awake-only rule).
- `connectedNow` answers `null` (not a stale boolean) when the last presence frame is older than 15 min; the sentence then says "whether <peer> is connected right now is unknown" rather than guessing.

## 2. Under-block

- `dark` cannot tell offline from wrong-address; the data model carries no cause. The wording says so on every surface. The relay-side `recipientLastSeenAt` that could tell them apart is §Out of scope (CMT-026).
- A dark peer whose rows are ALL older than 30 days leaves `allPeerHealth` and its open item is resolved only if life arrives; an item for a peer that never comes back stays open until the operator closes it (the cooldown and the 30-day prune bound the surface, not the item).
- The sentinel raises on the awake machine only; if the lease moves while an item is open on the old machine, that machine resolves it when it next ticks on pool evidence (the deterministic id makes a later re-raise on the new machine the same item name, not a duplicate flood).
- The pool read for raise/resolve is best-effort: a peer machine that is down answers nothing, so its acks are invisible for that tick — the local verdict stands (audited `pool-read-failed`). A false raise on a peer that answered ONLY on a dark machine is possible for the length of that outage; the resolve catches it on the next tick the machine is back.
- `identitySelfCheck` is `unknown` until §2 lands its wiring; the "if I am the split one, that item supersedes this" branch is inert until then (both items can coexist for a split in the meantime).
- The route's `peerDark` is THIS machine's ledger only (per spec): a standby's own queued rows are never consulted on a send, because a standby never computes the field (its send is forwarded).

## 3. Level-of-abstraction fit

Right layers. The classification lives where the rows live (the tracker), the presence read lives on the client that owns the map, the send-time sentence lives in the one route every A2A send funnels through (the MCP tool and the forward path both transcribe it), and the operator notice reuses the sentinel that already owned "a peer went dark" instead of a parallel watcher. The Attention queue (upsert / status) is the existing notice surface; no new topic, no new channel. Nothing here duplicates the relay's own expiry logic — it reads the verdicts the relay already sends.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

Every piece is a read or a notice: `dark` is a time threshold over durable rows, `connectedNow` is a presence-map lookup, `peerDark` is a response field, the sentinel raises/resolves Attention items. No send, receive, or session is gated; a failing ledger read answers `dark: unknown` (no item, one audit row) and a failing pool read degrades to the local verdict. The only "authority" is the operator's dry-run flip.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The dark threshold, the cooldown and the 30-day retention are invariants over time (enumerable: a duration), declared in the spec's "Decision points touched" table as tier-0 invariants; the raise additionally requires the heal to have run (a floor, not a judgment). Where signals genuinely compete — offline vs wrong-address — the change does NOT decide: it reports both possibilities in the wording and leaves the cause to the relay-side corroboration tracked in §Out of scope.

---

## 5. Interactions

- **Legacy redelivery loop:** unchanged under its own gate. With the peer-dark gate ALSO on, its `markEscalated` state change still happens but the stamped `a2a-redelivery-<ts>` item is NOT raised beside the dark item (one voice per peer). An `escalated` row stays in the unanswered set so it cannot suppress an episode (spec §3.2).
- **Silence sweep (`honestDeliveryWiring`):** the retention delete rides the same `sweepSilence` call; its audit row shape is unchanged (deleted rows are counted on `lastPruned` / `prunedTotal`, not listed).
- **`stale` (6 h):** untouched. `dark` (2 h) sits below it so the sender hears first; a `delivered`-unacked peer can be stale without being dark.
- **Relay forward (standby):** the holder computes `peerDark`; `buildForwardAnswer` spreads the holder body so the standby's caller sees it. No change to the forward module.
- **Hub-routed Attention:** `upsertAttentionItem` reopens the same id on a later episode and re-posts when the body changes (the resolve line lands through it, then the item is set `DONE` silently). `createAttentionItem`'s dedupe-on-id would have swallowed a reopen — that is why the §3 items use upsert.
- **`/threadline/peers/health` pool scope:** rows merge as today; the new fields ride along (an older peer answers without them — `darkCount` counts only `dark === true`).
- **Double-fire:** the sentinel tick is single-flight (`ticking` guard); the two heal passes are inside one tick. A restart rebuilds an open per-peer episode from the durable item (no second raise), and the aggregate item's durable OPEN state is consulted too, so a relay that comes back after a restart still resolves it.
- **Legacy item while the new path is dry-run:** the legacy per-message stamped item is suppressed only when the §3 path is LIVE (`enabled && !dryRun`). With legacy redelivery on and the new path in dry-run, the legacy item still goes out — there is no silent window; a would-raise row is written beside it.

## 6. External surfaces

- Other agents: nothing new leaves the machine. The one discover in the heal is a call the client already makes at connect; the reconnect is the existing re-arm. No new relay frame types.
- Operator: ONE new per-peer Attention item kind + ONE aggregate kind, both dark (dry-run) on every agent until a deliberate flip; the send response and health reads gain fields (additive JSON).
- Timing dependence: `connectedNow` depends on frame freshness (15 min) — honest `null` otherwise; the dark threshold depends on wall-clock vs ISO `sent_at` (the tracker's existing invariant).
- Peer-supplied text: display names are clamped + HTML-escaped in every sentence and item body (`peerLabel`); audit rows carry fingerprints, counts and timings only — never bodies or thread ids.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read** for the ledger + `dark` (rows live on the machine that carried the send; `GET /threadline/peers/health?scope=pool` merges them — existing), with the item **raised by the awake machine only** (the only one whose heal may run) and **resolved on every machine over its own item store** from the pool-scope read, under one deterministic id so a lease move cannot strand it. `connectedNow` is **machine-local by design** (the presence map belongs to the one relay connection; a standby has none and answers `null`; its sends are forwarded so the holder computes the field). The dry-run audit log is machine-local (one file per machine, like the sibling A2A logs). One-voice: a single item id per peer; the aggregate suppresses per-peer items while my relay is down. No durable state is created that would strand on topic transfer (items are per-agent, not per-topic). Single-machine agents: the pool read answers `[]` and every verdict is local.

## 8. Rollback cost

- Flag off (`threadline.peerDarkNotice.enabled: false` — the sentinel's construction reads it at boot; the send-route sentence and the health reads read it live): the raw health fields stay populated (they are reads), no sentence, no item; the sentinel is then constructed only under `monitoring.a2aRedelivery.enabled` — today's behaviour. Dry-run back on: `dryRun: true`.
- Code revert: additive JSON fields disappear; the retention delete and the `findOverdue` bound revert (rows already deleted are gone — they were 30+ days old in terminal/unanswered states and the spec accepts that); `PeerHealth` loses the fields (older peers already tolerate their absence).
- No data migration, no hook, no skill. The CLAUDE.md section is content-sniffed; a revert leaves a harmless paragraph on migrated agents.

## Class-Closure Declaration (display mirror — the counted host is the decision-audit entry)

- **Defect class:** `unbounded-self-action` — the reworked `A2ARedeliverySentinel` is a self-triggered controller (a sweep tick that reconnects a relay, runs a discover, raises and resolves Attention items).
- **Closure:** `guard` — ratchet `tests/unit/self-action-convergence.test.ts` over the registry model `a2a-peer-dark-raise` (`src/testing/selfActionRegistry.ts`; source marker `@self-action-controller: a2a-peer-dark-raise` in `src/monitoring/A2ARedeliverySentinel.ts`), which proves one emit per (peer, episode) under 24 h of sustained silence, horizon-independent and restart-stable. The brakes it models, enforced inside the controller: per-peer 12 h cooldown (in-process AND the durable item's last update, restart-safe); one deterministic item id per peer (reopen, never a stamped flood); ONE aggregate item while my relay is down with per-peer items suppressed; single-flight tick (`ticking`); heal capped at two passes 40 s apart inside the 120 s ceiling; `findOverdue` bounded to 500 rows and the ledger pruned at 30 days; dry-run default (`threadline.peerDarkNotice.dryRun: true`) so nothing is raised on the fleet until a deliberate flip. Every would-raise / raise / resolve / skip lands in `logs/a2a-peer-dark.jsonl`.
- **How caught:** spec §3 named the brakes up front (Watchers table row "Dark peer with queued sends"); `tests/unit/a2a-peer-dark.test.ts` covers cooldown, reopen-after-cooldown, restart rebuild (no duplicate raise), aggregate-replaces-per-peer, standby-no-heal.

---

## Second-pass review

**Required** — the change touches a sentinel (name + behaviour) and the Attention surface. Reviewer: an independent subagent reading this artifact and the diff, without the author's conclusions.

**Reviewer response (verbatim, independent subagent, 2026-10-09 11:37 PDT):**

> Checked the artifact against the live diff, the four new files, spec §3 / Watchers row / AC5, and `docs/signal-vs-authority.md`. Unit file runs green (41/41).
>
> 1. **Signal vs authority** — holds. The route computes `peerDark` after the send is already submitted; the sentinel only reads the ledger, raises/resolves Attention items, and re-arms an existing relay client. No 4xx/hold path anywhere.
> 2. **Dark pass vs spec** — matches: trigger `dark && queuedCount>0` → pool-scope clear → awake-only heal (two passes, 40 s) → second-pass re-read → cooldown → raise with `a2a-peer-dark:<agent>:<peerFp>`; resolve runs before the awake check on every machine; aggregate on relay down; dry-run writes to `<stateDir>/logs/a2a-peer-dark.jsonl`.
> 3. **Send path** — local `peerHealth` + `peerConnectedNow` only; no discover, no fan-out. ✓
> 4. **`delivered` as life** — `lastDelivered` is folded into `lifeBound`; the route skips the read entirely on a `delivered` verdict. ✓
>
> **Discrepancies (artifact vs code):**
> - The legacy stamped item was suppressed on `!peerDark.enabled`, not on live — with legacy ON and the new gate in dry-run no item would be raised at all.
> - `aggregateOpen` was in-process only; a durable OPEN `a2a-relay-unreachable` item would not resolve after a restart until the relay dropped again.
> - §8 said the flag is "read at boot"; the route reads it live for the sentence, only the sentinel's construction is boot-read.
> - `peerConnectedNow` used a per-row stamp where the spec says "last presence frame older than 15 min".
> - The route added `+1` to `queuedCount` whenever this row was not yet `queued`, including on a `rejected` verdict.
> - Spec §3.1 enumerates three states; code adds `escalated`-not-delivered. Disclosed; note only.
>
> None of these touches blocking authority or the §3 guarantees; they are alignment-pass fixes.
>
> Concur with the review

**Author follow-up (same session):** all five discrepancies fixed in code before commit — legacy item suppressed only when `peerDarkLive`; the aggregate resolve consults the durable item state; `peerConnectedNow` keys freshness on the last presence frame; `+1` only on a `queued` verdict; §8 wording corrected above.

**Follow-up commit (same session):** full-suite alignment — the dev-gate hand map shifted +15 for the new config block, the audited pool-read fallback carries its marker, and the peer-health route fixture sits inside the 30-day window.

**Review folds (peer review of §3, built 2026-10-10):** three changes asked for by the receiving agent's review and accepted before the build closed. (1) `perPeer` thresholds: a config map by peer fingerprint, resolved with the same floor, capped at 200 entries, applied on the health reads, the send read and the sentinel; a signal-only tuning knob with no new authority. (2) `connectedNowReason` + `connectedAsOf`: additive read fields; the sentence now states the record's age ("as of N min ago") and, when unknown, which side the unknown is on. (3) `delivered` no longer counts as a sign of life: `lifeBound` in the ledger and the sentinel's pool-scope life both read ack + inbound only. This supersedes item 4 of the second-pass review above ("`delivered` as life"). Under-block effect: none added. Over-block effect: none (no send is gated); the notice can stay up slightly longer for a peer that returns without acking, stated in §1. Rollback is unchanged (`threadline.peerDarkNotice.enabled: false`; the fields are reads). Spec §3.1/§3.2/§3.4 text was brought in line in the same commit.

**Second-pass review of the folds (independent reviewer, 2026-10-10): concern raised, then fixed.** The reviewer confirmed folds (1) and (2), that no send is gated, that every threshold consumer reads the per-peer value (including the post-heal re-check), and the presence edge cases. It raised two real defects in fold (3): a relay queue FLUSH rewrites queued rows to `delivered`, which dropped them out of the unanswered set and cleared `dark` with nothing from the peer (the exact split case the fold exists for); and after such a flush the open item could never resolve. Fix: a row the relay queued and later handed over (`delivered` with `relay_expires_at` still set, a column only a queued verdict writes) stays in the unanswered set until an ack or an inbound; `handedUnackedCount` counts those rows apart and the sentence and item body name them, so nothing handed over is called "queued". The peer therefore stays a candidate and the item resolves on the first ack or inbound. Two minors also fixed: the per-peer map is null-prototype with an own-key lookup (a fingerprint such as `constructor` reads the default), and the boolean-only presence reader no longer has a reason guessed for it. Known remaining edge, accepted: an `unconfirmed` row that receives a late `delivered` verdict has no queued marker and leaves the set; that needs a 24 h-late relay verdict and is bounded by the `stale` window. Tests for each fix are in the unit file.

**Reviewer re-check of the fix (same reviewer, 2026-10-10): Concur with the review.** Verified in code: `relay_expires_at` has a single writer, set only on a `queued` verdict and kept on a later `delivered`, so it is a reliable "queued, then handed over" marker; no path clears `dark` without an ack or an inbound; acked flushed rows leave the set and an inbound reply excludes them, so nothing reads falsely dark; the open item resolves on the first ack or inbound. One residual it named, which this change did not introduce: a peer that never returns loses its rows at the 30-day retention, and an item still open for it then has no automatic resolve path (the operator closes it by hand).

