# Side-Effects Review — Machines read the same from any machine; Resource usage covers every machine

**Version / slug:** `machines-agnostic-resources`
**Date:** `2026-11-06`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1 (read-only, revert fully undoes it). 13 files, ~470 added / ~60 removed lines, one review round, first commit attempt. Driven by Justin's feedback of 2026-11-06 22:55 PST (topic 134088): the iPhone app's Machines screen said "this one" / "Live (this machine)" and printed an evidence chain, and Resource usage reported only the machine that answered the phone.

- `src/server/mobileOpsRoutes.ts` — `summarizeMachines` writes a short, agnostic `statusLine` ("Live · load normal", "Not answering") built from the pool row's state and load, and a separate `evidenceLine` for a machine's detail, built from the structured `liveness` block with the checking machine named ("Checked 3 s ago by Mac Studio."). Rows sort trouble first, then the leading machine (not "self first"). The no-pool fallback row is named after the machine, never "This machine". `machineKey` is exported (pinned by test; the app recomputes it).
- `src/server/mobileCapacityRoutes.ts` — `GET /mobile/resources` adds `scope: 'pool'`, `combined` and `machines[]` (one block per machine) on top of the unchanged top-level fields (older phones keep reading those). Each peer is asked for its own `/mobile/resources?scope=local` answer; `?scope=local` never fans out. `summarizeResourceMachines` re-reads every peer answer through a field allowlist. A machine that does not answer is `not-answering` with no numbers. Single-flight cached 15 s like accounts/spend.
- `src/server/routes.ts` — wires `resourceMachines` (from the same `/pool` summary the Machines screen uses) and `peerResources` (existing `poolPeerFetch` helper, bearer, 5 s timeout).
- `dashboard/console/machines*.js` — no "this one" tag; order independent of the serving machine; every machine card shows its resource line and its sheet shows "What's using it" from the pooled read plus a Remote desktop link (the desktop page already explains a machine that isn't ready and shows its setup).
- `src/core/PostUpdateMigrator.ts` — the agent-awareness bullet now says resources cover every machine; an idempotent migration rewords the old clause on existing agents.

### Second commit: no "this machine" anywhere on the phone

Follow-up the same night (same rule, coordinator request): every phone-facing line that said "this machine" now names the machine or drops the qualifier.
- Spend: "Limits are on and enforcing on Mac Studio." The paid route's holder is named; the headline reads "on Mac Studio".
- Accounts: "Mac Studio's account list can't be read right now."
- Messages: "held on Mac Studio"; the machine list names it.
- Keys: "The saved keys on Mac Studio can't be opened."; "The agent holds 2 keys."
- Session settings: no "(this machine)" label; "(on Studio only)"; "Move this session to Studio …".
- Inside: "None of these checks are on for Mac Studio". A peer's activity line names that peer; before this it wrongly said "this machine" for the peer.
- Plans and the session screens: the self qualifier is gone.
- Permissions: `/mobile/permissions/features` gains `machine`, the answering machine's name, so the phone titles its switches by name.
- Media, conversation and pairing error details are worded without a machine ("The agent does not know that upload", "Messages aren't being received right now").

Each module takes an optional `selfName` dep (the verified registry name, the same source the capacity routes already used). With no verified name, the qualifier is dropped; it never falls back to "this machine". Pairing-setup diagnostics that describe the tunnel machine itself stay as they are: they describe that machine's own setup, are shown during pairing, and name the host.

## Decision-point inventory

No decision-point surface: read-only summaries and wording. Nothing gates, blocks, or filters.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Right layer. Wording is decided in the phone-facing summarizer (the place that already owned the phone's words), from structured fields rather than re-parsing the shared `livenessLine` (which other surfaces still use). The pooled read reuses the existing peer-read helper and single-flight cache the accounts/spend reads use, instead of adding a new fan-out mechanism.

---

## 4. Signal vs authority compliance

No authority added. Pure observability reads.

## 4b. Judgment-point check

No competing-signals decision point; not applicable.

---

## 5. Interactions

- Older phones: top-level `/mobile/resources` fields are unchanged; extra fields are ignored. Older phones' machine rows show the new shorter `statusLine` (an improvement for them too).
- Older peers ignore `?scope=local` and answer their own local view (they have no fan-out), so no recursion either way.
- Single-flight cache keyed `resources` shares one fan-out across concurrent phone and dashboard reads.
- The dashboard sheet no longer reads `/resources/summary` for its own machine; it uses the pooled read. `/systems/status` and safety checks stay machine-local, as before.

---

## 6. External surfaces

`GET /mobile/resources` answer grows (`scope`, `combined`, `machines`); `GET /mobile/machines` rows gain `evidenceLine` and change `statusLine` wording. Both owner-only (phone or bearer). A peer's free text is scrubbed and capped; no ids, pids or paths are passed through (unit + integration tests assert this). Read latency: up to the 5 s peer timeout on a cold cache, as with accounts/spend.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: the Machines page shows each machine's state and resource line on its card; tapping opens the machine with resources and a Remote desktop link.
2. **Zero raw internals?** Yes: no ids or hashes shown; machine ids appear only in the desktop link's query string.
3. **Destructive actions de-emphasized?** No destructive actions added (Rename unchanged).
4. **Plain language + phone width?** "Using 12% CPU · 1.0 GB", "Not answering"; the existing card layout, no new tables.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read.** Resource use is machine-local state (each machine's resource ledger) served pool-wide by `GET /mobile/resources` (default scope), which asks each online peer for `GET /mobile/resources?scope=local`. Registered machines not online are listed as offline; a peer that fails is "not answering", never zeros. Machine wording is identical whichever machine answers (asserted by test). No notices, no durable state, no generated URLs beyond the existing desktop page link, which carries the machine id and is served by any machine's dashboard.

**Status surfaces:** none of `/status`, `/health`, `/capabilities`, `/channels` change.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state. The CLAUDE.md bullet rewording would stay on agents that already migrated (harmless, slightly ahead of the code).

---

## Conclusion

Clear to ship. The review moved evidence wording off the shared `livenessLine` (which says "this machine") onto the structured liveness fields, and added the `?scope=local` no-fan-out rule and the allowlist re-read of peer answers.

## Evidence pointers

- `tests/unit/mobile-native-ops-screens.test.ts` — agnostic wording from two different answering machines, evidenceLine, pinned machineKey.
- `tests/unit/mobile-native-capacity-screens.test.ts` — combined summary, not-answering never zeros, stale handling, peer allowlist.
- `tests/integration/mobile-native-capacity-screens.test.ts` — pooled answer over the signed phone path; `?scope=local` never fans out.
- `tests/e2e/mobile-native-*-alive.test.ts` — production wiring answers both scopes; no "this machine" in machine rows.
- `tests/unit/console-machines.test.ts` — dashboard page in a DOM: no "this one", pooled resources on cards and sheets, Remote desktop link for a peer.
