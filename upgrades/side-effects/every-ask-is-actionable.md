# Side-Effects Review — Every ask is actionable (console needs-you taps + Attention hub buttons)

**Version / slug:** `every-ask-is-actionable`
**Date:** `2026-10-26`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Operator rule (2026-10-26): anything brought to the operator is immediately actionable. `dashboard/console/shared-counts.js` now gives every needs-you item an `action` (approve in place via POST, or a deep link / GitHub review link) and `needsYou()` moves any item without one into `agentOwned` instead of the count. `dashboard/console/actions.js` (new) renders the tap on Home and on the Promises, Accounts, Development and Passwords & keys pages; pages land on `item=` deep links. Server side, `src/messaging/attentionAction.ts` (new) decides an attention item's tap from its category/id (or a validated producer `action`); `GET /attention` stamps it, `POST /attention` validates it, and `TelegramAdapter.routeToAttentionHub` attaches it as an inline URL button through the tunnel URL (`setPublicBaseUrlResolver`, wired in `server.ts`), logging buttonless posts to `logs/attention-unactionable.jsonl`. `GreenPrAutoMerger.configurationView()` now names the repo. CLAUDE.md template + migration bullet.

## Decision-point inventory

- `shared-counts.needsYou` — modify — an item without an actionable `action` is no longer counted as needing the operator (moved to `agentOwned`, shown under "What I'm doing").
- `attentionActionFor` — add — deterministic category/id → console page mapping; display routing only, no authority.
- `POST /attention` `action` validation — add — refuses (400) an `action` that is not a console hash path; absent `action` unchanged.
- `TelegramAdapter.routeToAttentionHub` — modify — adds an inline URL button; never withholds the post.

---

## 1. Over-block

`POST /attention` refuses only a malformed `action` field (a non-console URL, missing label, label > 40 chars); requests without `action` behave exactly as before. A producer that sends a valid link to an external site (e.g. a GitHub URL) is refused — deliberate: the button must open the operator's own console. The needs-you count drops items with no action; that is the operator's rule, and they stay visible under "What I'm doing".

---

## 2. Under-block

An attention item whose category/id matches no rule and carries no producer action is not counted as needing the operator, even if its text asks for a decision. It is still listed with the agent's work and, when it reaches Telegram, logged to `logs/attention-unactionable.jsonl` so the producer gets fixed. Items served by an older peer server (no `action` key) are stamped by this server after the pool merge, so the mapping still applies.

---

## 3. Level-of-abstraction fit

The tap is decided once per surface family: server-side for attention items (one TS rule shared by the GET stamp and the hub post), client-side in shared-counts for the kinds the console builds itself (promises, sign-in taps, PRs), which already owns the needs-you definition. The approve action reuses the existing route (`/subscription-relogin/repair-cell`) and the existing PIN sheet; no new authority.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The mapping decides which button to show, not whether anything may happen. The only refusal is input validation of a new optional field on `POST /attention`. Approvals still go through the existing routes and their existing auth.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The category/id → page table is an enumerable routing table for display (where to send the operator's tap), not a judgment about whether to act.

---

## 5. Interactions

- **Shadowing:** the hub filter (`admitItemToHub`) still runs first; buttons are only built for posts it admits. The 6-hour repost throttle is unchanged.
- **Double-fire:** none — the button is attached to the one existing hub send. A relayed send (tokenless standby) appends the URL to the text instead of markup, so the holder posts it once.
- **Races:** `consumeItem()` rewrites the address with `history.replaceState` (no hashchange), so a page's 30-second refresh does not reopen a sheet the operator closed.
- **Feedback loops:** none.

---

## 6. External surfaces

- Telegram: Attention hub posts gain an inline URL keyboard (`reply_markup`) pointing at `<tunnel>/dashboard/console/#/…`; never localhost or plain http.
- Persistent state: one new append-only log, `logs/attention-unactionable.jsonl` (best-effort, failures logged to console).
- API: `GET /attention` items gain `action` (object or null); `GET /green-pr-automerge` `configuration.repo`; `POST /attention` accepts `action`.
- **Operator surface:** every action this adds is phone-completable — links open console pages; the one in-place approval uses the existing PIN sheet.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes — each needs-you row shows its button directly under it on Home's first card, no toggle; deep links open the exact item's sheet or mark its row.
2. **Zero raw internals as primary content?** Yes — button words are plain ("Approve repair", "Answer", "Review on GitHub", "Open sign-in"); ids live only in the URL.
3. **Destructive actions de-emphasized?** No destructive action is added; approval asks for confirmation first.
4. **Plain language + phone width?** Verified live at 390 px against the Mac Studio's data: no horizontal scroll (`scrollWidth - innerWidth = 0`), 40 px tall buttons.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read** for attention actions: each server stamps its own items and the pool-merge stamps any peer item lacking one, so `?scope=pool` reads carry actions from every machine. Hub buttons use the holder's tunnel URL; the console behind it reads the pool view. The unactionable log is **machine-local by design** (one audit per posting machine, like `attention-hub-held.jsonl`). No new user notices; no durable state that strands on topic transfer; URLs point at the tunnel, which survives machine boundaries through WS4.4 links where enabled.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. The only new state is an append-only audit log, safe to leave. During rollback the console shows the old text-only rows and posts lose their button; nothing breaks.

---

## Conclusion

Clear to ship. The review produced one design change: account cells keep their old repair-action string under `repairAction` so the Accounts page's own buttons are unaffected while the shared needs-you item carries the new `action` object. Follow-up: producers whose posts land in `logs/attention-unactionable.jsonl` should add an `action` at the source.

---

## Second-pass review (if required)

Not required.

---

## Evidence pointers

Unit: `tests/unit/console-actionable.test.ts`, `tests/unit/attention-action.test.ts`, `tests/unit/PostUpdateMigrator-attentionActionable.test.ts`; integration: `tests/integration/attention-actionable.test.ts`, `tests/integration/green-pr-automerge-routes.test.ts`; e2e: `tests/e2e/console-home-lifecycle.test.ts`. Live 390 px screenshot of Home taken against the Mac Studio.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
