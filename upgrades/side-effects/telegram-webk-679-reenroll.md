# Side-Effects Review — Telegram Web K 679 re-enrollment entrypoint + drift attention

**Version / slug:** `telegram-webk-679-reenroll`
**Date:** `2026-10-16`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Telegram shipped Web K build 679 on 2026-10-16. The typed browser route (`POST /telegram/browser/:profile/send`) refused it correctly, but silently: peer resolution threw `browser-peer-canary-unavailable` from the broker's read path, which never called the durable recovery latch's `failure` action, so no `failedBuilds` entry and no attention item were recorded, while `begin` had already armed the 15-minute floor. There was also no runnable re-enrollment path. This change:

- `TelegramBrowserBroker`: reads (snapshot, peer resolution) now run the same bounded recovery as writes: build canary, ONE fresh-process recheck, `failure` (non-final then final) through the existing durable latch, then hold. A supported canary records `success`. A read or write that finds the enrollment proof changed retires the stale driver so the next call starts under the new enrollment.
- `OriginBrowserRecovery`: attention is one item per failed build (spec wording), raised only after the final recheck, never twice for the same build in an episode. The episode latch still owns the 15-minute floor.
- `TelegramOriginBoot`: each driver start reads the live enrollment (builds + proof) so re-enrollment applies without a server restart; account and directory stay boot-pinned.
- `ReviewedWebKBuilds.ts` (new): reviewed build list (679, 676) with exact asset digests, evidence path per build.
- `OriginBrowserEnrollment.enrollReviewedOriginBrowser` + CLI `instar telegram-origin enroll-browser <profile>` (new, local-only, not HTTP): retire the profile's processes, authenticated read-only canary (principal, exact asset census + digests, self peer resolution), refuse unless reviewed, then `enrollOriginBrowser` with `[observed, one prior reviewed]` (max two).
- `getBrowserRecoveryStates` exposes `failedBuilds` on the existing status surface.
- CLAUDE.md template + `migrateClaudeMd` (+ shadow mirror): Web K drift paragraph; corrects "one attention item per episode" to "per failed build".
- Evidence: `docs/specs/reports/telegram-message-origin-evidence/web-k-2.2-679-review.md`.

## Decision-point inventory

- Broker read path canary gate — modify — reads now hold on an unsupported build (snapshot previously served on any build with the right account).
- Browser recovery attention latch — modify — per failed build instead of per episode.
- Broker ownership predicate — modify — stale driver retired on proof change instead of a permanent hold.
- Reviewed-build admission at enrollment — add — deterministic exact-digest match against a code-reviewed list.

---

## 1. Over-block

The snapshot route now returns 409 on an unreviewed build where it previously returned page text. That is the spec's posture ("a failed broker canary keeps that transport held"); the snapshot is read-only, so the cost is losing a diagnostic read during drift. The enrollment entrypoint refuses any build not on the reviewed list, including a genuinely compatible one — by design; adding a build is a reviewed code change.

## 2. Under-block

A build whose asset names are unchanged but whose worker bundle changed is not detected (the census does not list worker bundles; unchanged from 676 posture). The review evidence records the worker bundles for provenance. Accepted, as before.

## 3. Level-of-abstraction fit

The fix reuses the existing durable recovery latch and the boot's existing attention callback, rather than adding a parallel alert. The entrypoint wraps the existing `enrollOriginBrowser` library function; the only new decision is the exact-digest match.

## 4. Signal vs authority compliance

- [x] No new brittle blocking authority. The canary gate already held writes; extending it to reads uses the same deterministic build-identity floor (an irreversible-action safety guard: an unreviewed client must not touch the operator's account). The attention item is a signal. The enrollment match is a safety floor on a privileged operator action, deterministic by design.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Build identity is enumerable (exact digest equality).

## 5. Interactions

- Recovery `begin` / `success` are now also called on reads; `success` lifts the floor exactly as on a write. A cached healthy driver records `success` on each read (one durable row write).
- The enrollment entrypoint SIGTERMs exact-profile browser processes (same matcher enrollment already used), which kills the server's cached driver; the broker then fails its next call and starts fresh. No send is in flight from the canary.
- The boot's attention callback is unchanged; its id now includes a build hash so a second build raises its own item.

## 6. External surfaces

Operator sees one HIGH attention item per failed Web K build (hub-only), instead of nothing. New local CLI subcommand. No new HTTP route. No Telegram message is sent by any path in this change.

## 6b. Operator-surface quality

No operator action is required: re-enrollment is a maintainer task (the agent runs the CLI). The attention text is unchanged.

## 7. Multi-machine posture

Machine-local by design: the managed browser profile, its enrollment and the recovery latch live on the machine that holds the logged-in profile (the registry is machine-local; the origin store is per-machine). Each machine with an enrolled profile raises its own item and is re-enrolled on that machine.

## 8. Rollback cost

Code-only revert. Registry entries written by the entrypoint use the existing schema (two builds, existing proof shape), so an older binary reads them. Recovery state gains an optional `signaledBuilds` array that older code ignores.

## Conclusion

Closes the silent-hold gap the spec forbids and adds the missing trusted re-enrollment step. Safe to ship.

## Second-pass review (if required)

**Concur with the review** (independent reviewer subagent, 2026-10-16). Notes, all accepted as non-blocking:

- The reviewed list gates the CLI; at driver start the broker trusts the registry's `supportedBuilds`, as it did before this change (a hand-edited registry was already honoured at the next restart). Not a regression.
- Live enrollment re-read still requires `exclusiveEnrollment`, the boot account and the boot directory; a mid-send change is still refused by `valid()`.
- Attention bounded: final recheck only, once per build per episode, capped list, reset on success; 15-minute floor unchanged.
- Reads now share the hold and floor with writes (intended); every read runs a canary first (latency), and the snapshot holds on an unreviewed build.
- A refused re-enrollment still retires the server's running browser (processes are retired before the canary). Any in-flight send ends held/outcome-unknown (safe direction). The CLI now says so on refusal.

## Live application (Echo, Mac Studio, 2026-10-16)

`instar telegram-origin enroll-browser justin-telegram` from the worktree build, under the pipeline browser lock: enrolled `web-k-2.2-679`, supported builds `[web-k-2.2-679, web-k-2.2-676]`, 0 messages sent (`docs/specs/reports/telegram-message-origin-evidence/authenticated-web-k-canary-679.json`). An independent read-only `canary()` on the live enrollment returned `supported: true` for `web-k-2.2-679` with the expected operator account. The running server (v1.3.1354) pins its boot-time enrollment proof, so its snapshot route keeps answering 409 until it runs a build with this change (the auto-update restart) — the server was deliberately not restarted.

## Evidence pointers

- Unit: `tests/unit/telegram-origin/browser-reenrollment.test.ts`, `tests/unit/telegram-origin-browser-drift-migration.test.ts`; existing `tests/unit/telegram-origin/*`, `tests/unit/telegram-origin-browser.test.ts` green.
- Integration: `tests/integration/telegram-origin-browser-drift.test.ts` (HTTP send/snapshot under drift).
- E2E: `tests/e2e/telegram-origin-webk-drift-reenroll.test.ts` (production `bootTelegramOrigin`, real `TelegramWebKDriver` over a CDP pipe to a fake browser, real re-enrollment, no restart).

## Class-Closure Declaration (display-only mirror)

Class: an unsupported browser build observed on any broker path must reach the durable recovery latch. Both broker entry points (`execute`, `readDriver`) now do; there is no third path to the driver.

- `unbounded-self-action` — closure: `guard` — citation: `tests/unit/self-action-convergence.test.ts` (ratchet; `telegram-browser-canary-recovery` is registered). The read path reuses the persisted 15-minute begin floor and the per-build attention latch, so browser process starts are at most one per 15 minutes per profile and attention is one item per failed build; reads are caller-driven, never self-scheduled; the CLI's process retirement is a one-shot operator command.
