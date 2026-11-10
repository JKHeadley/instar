# Side-Effects Review — the agent can read the team settings summary

**Version / slug:** `team-switches-agent-read`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, about 7 source files plus tests, one commit attempt. The agent's own instructions ("Registry First — team settings") told it to read `GET /mobile/team/context` → `teamSwitches` to answer "is something off that team access needs?". That route answers only the owner's paired phone, so the agent token got 403 and the agent could not follow its own rule (found live on Echo 2026-11-10 01:55). This change adds the same read-only summary, from the same `teamSwitches()` helper in `src/server/teamRoutes.ts`, to the agent-token `GET /team/people` answer (`src/server/routes.ts`) as `teamSwitches` (an array of lines, or `null` when no team router is mounted). The team router publishes the helper on `MobilePairingService.teamSwitchesSummary` (`src/server/mobilePairingRoutes.ts`). The CLAUDE.md template line (`src/scaffold/templates.ts`) and the PostUpdateMigrator now name `GET /team/people`, and a content-sniffing, idempotent migration rewrites that one phrase on an already installed team-settings line (bullet or table row).

## Decision-point inventory

- `GET /team/people` response — modify — adds a read-only field; no decision.
- `POST /mobile/team/switches/turn-on`, `POST /mobile/team/memory-privacy` — pass-through — unchanged, still owner phone + Face ID only; the test proves the agent token is refused.
- PostUpdateMigrator CLAUDE.md patch — modify — one phrase rewrite on one line, content-sniffed.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Right layer: the summary is computed once by the existing helper and served by two reads (phone route and agent route). No re-implementation; the agent route calls the same closure.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic — STOP.

It is a read. It gives the agent no authority: turning a setting on stays the owner's Face ID tap.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** none; a new field on an existing answer.
- **Double-fire:** none; nothing acts on it.
- **Races:** the summary reads the puller standings and the switch-request file at request time, the same as the phone route.
- **Feedback loops:** none.

---

## 6. External surfaces

- The `GET /team/people` JSON gains `teamSwitches`. Existing readers ignore unknown fields.
- Installed CLAUDE.md files get one phrase rewritten on the team-settings line on the next update.
- **Operator surface:** no operator-facing actions added; the owner's turn-on stays in the app's People screen.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read**, inherited: the summary already merges this machine's standing with every peer standing the team exchange holds (`teamPuller.standings()`), one line per setting for the whole agent. No new durable state, no notices, no URLs. Status surfaces: none of `/status`, `/health`, `/capabilities`, `/channels` change; `GET /team/people` keeps its local/pool scope, and `teamSwitches` is already agent-wide on either scope.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. The migrated CLAUDE.md phrase would point at a route without the field; a revert would also revert the template, and a follow-up migration could restore the old phrase if ever needed. No persistent state.

---

## Conclusion

Clear to ship. The agent can now follow its own team-settings lookup with its own token, and still has no write path.

---

## Second-pass review (if required)

Not required (Tier 1, read-only).

---

## Evidence pointers

- `tests/integration/team-access-routes.test.ts`: the service summary equals the phone route's `teamSwitches`; the agent token gets 403 on the phone route and is refused on every turn-on route; nothing is turned on.
- `tests/integration/team-people-routes.test.ts`: agent-token `GET /team/people` carries `teamSwitches` with the line shape.
- `tests/e2e/team-people-alive.test.ts`: the field is present on the production AgentServer boot path.
- `tests/unit/PostUpdateMigrator-teamSwitchesRead.test.ts`: the rewrite on bullet and table row, idempotent; new installs and fresh migrations name the new route.
