# Side-Effects Review — Documents from any computer: a team invite opens a computer

**Version / slug:** `member-browser-any-computer`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

A team member without the Instar app joins a computer from the owner's team invite (spec `docs/specs/member-browser-any-computer.md`, converged in 6 rounds, PR #3556). The invite link carries `j=1` when documents and the browser switch are on. The instar.sh pair page then offers "Use this computer instead", and the agent's join page (`/docs/_join`) redeems the code for the browser's non-extractable key. The member confirms with the code shown only on the owner's phone (People), signing under a new `instar-join-v1` domain. The computer becomes a documents-scoped browser device, the same reach as a computer a member's phone links.

New team-log machine events (`computer-bind`, `computer-renew`, `computer-adopt`, `computer-limits`) replicate the binding, its renewal on use, takeover after a rebuild, and the allowance. A pure module (`src/core/TeamComputers.ts`) computes home, end, limits and standing from replicated rows. No machine writes these rows until every pool machine advertises it reads them (`seamlessnessFlags.teamLogComputerRows`).

Separately, ungated: team devices' pairing codes leave the dashboard PIN listing and PIN decline.

The files touched are:
- `src/core/{TeamAccessEvents,TeamAccessLog,TeamComputers,MobileDeviceKeys,PostUpdateMigrator,types}.ts`
- `src/server/{documentJoinRoutes (new),documentLinkRoutes,documentPageRoutes,mobilePairingRoutes,mobileBrowserDevices,AgentServer,middleware,CapabilityIndex}.ts`
- `src/documents/originCheck.ts`
- `src/commands/server.ts`
- `dashboard/docs/{join-page.js (new),doc-page.js,doc-page-model.js}`
- `site/src/pages/pair.astro`
- `src/data/awareness/member-computers.md`
- the documents spec's Decision 14 and §8 amendments

**Proportion:** Tier 2 (identity, a published interface, security-sensitive). About 1,300 changed lines across 27 files, including tests. The spec took 6 of 6 review rounds. Commit attempts are counted in the PR body.

## Decision-point inventory

- Join redeem: only a team code may register a computer — **add** (invariant, enumerable code roles).
- Join confirm: the owner-held code, signed by the pending key on its own host, within 5 minutes — **add**.
- The pool write gate for `computer-*` rows — **add** (refuses writes while a live machine doesn't advertise the reader).
- The allowance (count and hourly) — **modify**. It moved from hard-coded constants to the replicated limits row; the defaults are unchanged.
- `linkStillValid`, `documentDeviceKeyNow`, `documentDeviceKeyAt`, `deviceStoodAt` — **modify** (a branch for joined computers; the phone-linked path is unchanged).
- The sweep — **modify** (a joined computer is never revoked for expiry, only for removal).
- `GET /mobile/pairing-approvals` and PIN decline — **modify** (team devices are filtered out).
- `/mobile/device/confirm` — **modify** (refuses a `team-invite` pending record before reading any code).
- `mintTeamLink` — **modify** (appends `&j=1` when computers can join).

---

## 1. Over-block

- A member whose computer's clock is more than 5 minutes off can't confirm. The page says "Your computer's clock looks wrong" (a plain reason, not a silent refusal).
- While any pool machine heard from in the last week hasn't updated, every join and limits write answers 409 naming that machine. That includes a machine that is merely asleep on an old build: it is not advertising, because its last heartbeat didn't carry the flag. This fails closed on purpose. An older reader would hold every team phone on that machine (`gapsIn`).
- Three wrong codes end the waiting computer; the member then needs a new invite. This is the existing pairing constant.
- An owner's pairing link opened by hand on the join route is spent. The pair page never offers that, because it has no `j=1`.

## 2. Under-block

- A relayed lookalike page (the stranger's key redeems, and the member reads the stranger's check letters to the owner) is a stated limit, the same as for team phones (§3.6a item 6). It is reduced by showing the destination address and the waiting entry's address.
- Two machines admitting at the same moment can leave one person a computer over the limit. This is accepted: the limit bounds resources, not safety, since every computer is admitted with the owner's own code.
- A machine that forges a `computer-bind` or `computer-adopt` row stays within the stated limit that a machine can forge a binding (team-roles Step 2b).

## 3. Level-of-abstraction fit

The join reuses the existing anchor: the code held for the owner's People screen, the confirm attempt limit, the shared redeem steps (factored into `redeemArrival`/`takePairingCode` so both routes call one implementation), the documents scope, and the device-signature middleware's Send exception. The computer views are one pure module that the four existing check sites call, never parallel copies. The pool gate copies the shape of the existing `documentDecisionWritesBlockedBy`.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — every block here is an identity or authorization check over enumerable facts (code role, a signature, a held code, replicated rows). None is a heuristic judging meaning, so no brittle detector holds authority. The renew hook and the attention item are signals and never refuse anything.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The allowance and lifetimes are judgment-candidates with a floor (the replicated values) and an arbiter (the owner, through `POST /team/computer-limits`), as declared in the spec's §6. Every other rule is an invariant over an enumerable domain or an irreversible consequence, with its basis and evidence recorded in the spec.

## 5. Interactions

- **The phone redeem** now calls the factored helpers. Its behaviour is unchanged, and the existing pairing suites (integration and e2e) are green.
- **The browser-setup "another browser is waiting" check** now ignores joined computers. Before this, a member's waiting computer would have blocked the owner's console setup.
- **`phone-bind`** no longer overrides a key already bound by `computer-bind` (first bind wins). Phone keys and computer keys never coincide in honest use.
- **The documents page** gets `deviceUsed` and `computerEndsAt` hooks. Both are best-effort and never throw into a route.
- **#3518** also edits `site/src/pages/pair.astro` (LAN first phone). It is a different block of the file and will be rebased if both are open.

## 6. External surfaces

- New public routes (self-authenticating, listed in `DOC_PAGE_PATH`): `/docs/_join`, `/docs/_join/redeem`, `/docs/_join/confirm`, `/docs/_link/forget-self`, `/docs/_join/addresses`.
- New bearer routes: `/team/computers`, `/team/computer-limits`, `/team/people/:pk/computers/:id/forget`.
- Team links gain `&j=1` (every parser ignores unknown keys).
- The pair page gains a button, and the heartbeat gains `teamLogComputerRows` and `documentsOrigin`.
- The PIN dashboard no longer shows team devices' codes. This is the visible change on every agent.
- The attention item `team-computer-waiting:<id>` is new.
- **Deviations from the spec (recorded):**
  - A computer's list for the agent is a separate `GET /team/computers` route, not a `computers` field on `GET /team/people`.
  - Forget-self signs under `instar-join-v1` (op `forget`), not `instar-docpage-v1`. Docpage ops are bound to one document.
  - The pool gate treats a machine unheard for more than 7 days as retired, the same as the documents decision gate, instead of reading `origin-gone`.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The touched operator-facing surfaces:
- the join page (member-facing);
- the document page footer ("Forget this computer", the end-date line);
- the other-address links;
- the pair page button;
- the attention item and People entry text for the owner.

All text is plain and names the next step ("Ask Justin for your code. It's on their phone, in People, under your name."). The owner's waiting entry leads with "Computer", then the check letters, browser kind, address and time, so a technical identifier never stands alone. Phone width: the join page reuses the document page's `link-computer` styles, which are already phone-tested. The pair page button sits under the existing QR card.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Replicated:** `computer-bind`, `computer-renew`, `computer-adopt` and `computer-limits` ride the team log (vector pull). Activations and revocations ride the key ledger. Every machine judges every computer with `computerStandingIn`, and old comments verify everywhere.
- **Machine-local by design (physical-credential-locality):** the browser key in one origin's IndexedDB, which makes the machine serving that address the home and the single renew writer. Also the pending record, its held code and the confirm window (single-use credentials on the minting machine). A rebuilt machine at the same address adopts the replicated bindings.
- **Generated URLs:** the pair page navigates to the link's own origin; the other-address links come from the heartbeat's `documentsOrigin`.
- **Status surfaces:** `GET /team/computers` (bearer) reads replicated state; nothing new on `/health`.
- **Notices:** one item per waiting computer, raised by the machine holding it, so the owner hears one voice.

## 8. Rollback cost

- **Turning off documents or the browser switch:** all new routes answer 503, `j=1` stops, and computers stop working. Rows stay, harmless.
- **Reverting the code:**
  - older builds drop the four new events;
  - the joined computer's home revokes it on its first sweep, permanently;
  - members re-join after a re-upgrade with a new invite;
  - team phones' codes reappear in the PIN listing.
- **No data migration, no config change.**

## Conclusion

Ready to ship dark (dev agents). The fleet turn-on of documents is gated separately on the owner's Approve/Decline for browser keys in place of passkeys (documents spec Decision 14, amended here).

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact:** concur.

> Concur with the review. No path bypasses the anchor, the phone redeem refactor matches main step for step (one stricter `!reqHost` check), a joined computer's reach is the existing scoped-device path, historical verification and expiry-writes-nothing hold, and every computer-* write checks the pool gate. Minor: match the phone confirm's `pairingPaused()` check, and normalize the host before comparing. Both applied before commit.

## Evidence pointers

- Unit: `tests/unit/team-computers.test.ts`, `tests/unit/mobile-device-keys.test.ts`, `tests/unit/documents-page-model.test.ts`, `tests/unit/html-site-ratchet.test.ts`, `tests/unit/awareness-entry-registry.test.ts`.
- Integration: `tests/integration/documents-join.test.ts`, `tests/integration/mobile-dashboard-pairing.test.ts`, plus the existing documents, pairing and team suites (751 tests green).
- E2E: `tests/e2e/documents-join.test.ts`, plus the existing documents, team and pairing e2e suites (15 files green).

## Follow-up slice: the owner's phone removes a member's computer (2026-11-20)

The Apple app session (build 119) found that the owner's phone could not remove a member's computer. Only the agent token could, and `GET /mobile/team/people` carried no computers. This slice adds two things:
- An owner-only route, `POST /mobile/team/people/:personKey/computers/:deviceId/forget`. It is in the device allowlist with `ownerOnly`, re-checked in the route, and shares the forget helper with the agent's route.
- A `computers` array on owner reads of `GET /mobile/team/people`. A member's read is unchanged.

It takes access away only, and the owner is the one who may. Over-block, under-block and interactions: none new. It reuses the forget helper (ledger revocation plus `browser-unbind`). Multi-machine: the removal replicates as before. Rollback: revert, and the app's Computers section simply stays hidden. E2E: an owner phone lists and removes a computer, and a member's phone gets 403 and no list.
