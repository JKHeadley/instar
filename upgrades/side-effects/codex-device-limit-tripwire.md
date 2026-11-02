# Side-Effects Review — Codex device-limit tripwire

**Version / slug:** `codex-device-limit-tripwire`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see Second-pass review)`

## Summary of the change

Tier 2 (sign-in repair, session moves, a new LLM judge). OpenAI's new per-device limit on paid personal ChatGPT accounts would today look like an ordinary sign-out: the repair would retry up to 12 times per account per machine against a provider that just said "over the limit". This change adds a per-machine tripwire. `CodexDeviceLimitJudge` (Jev, Luna referee on another Codex account, truth table, budget, cache, masked input, provenance) judges the Codex app-server's own refusal text; `CodexDeviceLimitTripwire` benches an account on one machine only after two separate refusals 5–60 min apart, each freshly judged `device_limit`, and only while another Codex account here reads clean. A bench writes `statusCause` on the pool record (the authority), refuses repair admission (`device-limit-benched`), ends live repairs (`failed/device-limit`, no per-episode notice), defers slow retries, moves live sessions (`DeviceLimitSessionMover`), and raises one Attention row per machine. Session screens (SessionManager codex trigger) and sign-in pages (driver page judgement, helper `device-limit` hard line) can only request a fresh read or stop one repair. Files: new `src/core/CodexDeviceLimitJudge.ts`, `CodexDeviceLimitTripwire.ts`, `DeviceLimitSessionMover.ts`, `codexDeviceLimitWiring.ts`; modified QuotaPoller (read gate, per-read hook, `pollOne`, `requestCodexCheck`, restore hold, backoff skip), codexLiveRateLimitReader (refusal text, fresh result objects), CliLoginStatus (`checkWithText`), SubscriptionLoginLedger (cause + `supersedeCause`), SubscriptionPool (bench fields + store-level clearing rule), relogin Helper/Orchestrator/Store/Service/Policy/Runtime, AnthropicReloginBrowserDriver + ChromeCdpReloginBrowser (`mainText`), SessionManager, routes (`statusCause`, `deviceLimit`), server.ts composition, JevCascade (`accountOverride`/`requiredRoute` passthrough), selfActionRegistry, provenance exclusions (.gitignore, MachineIdentity GITIGNORE_ENTRIES, fileRoutes NEVER_SERVED_PREFIXES, BackupManager), dashboard grid, CLAUDE.md template + migration, `/subscription-signin` skill + migration. Proportion: spec 6 review rounds (Tier-2 cap), larger than the feature's job ("notice and stop knocking"); most size is precision on existing seams.

## Decision-point inventory

- Bench decision (is this refusal a device-limit lockout?) — add — judgment-candidate within a floor: Jev/referee judgement; two observations; machine floor; default no action.
- Stop one repair at a judged page / helper report — add — judgment-candidate; the stopped episode ends `failed` and is retried on the ordinary slow cadence unless the account is suspected or benched (self-undoing).
- Repair admission — modify — new first refusal `device-limit-benched` from the pool record.
- Slow retry scheduling — modify — deferred while suspected/benched (switch-aware); episode not mutated.
- Pool restore after a clean read — modify — device-limit hold (two clean reads release).
- Session swap off an account — pass-through — existing `onQuotaPressure` + existing brakes.
- Attention notice priority — add — invariant mapping (low/normal/HIGH).

---

## 1. Over-block

The tripwire blocks nothing users send; it benches an account (excludes it from placement/swap on one machine) and refuses repair for it. Legitimate cases it could wrongly bench: a provider refusal whose text Jev and the referee both misread as a device limit on two separate reads 5–60 min apart while another account here reads clean. Cost: one account on one machine skipped until two clean reads (if the login works) or the operator's set-active/ignore list; graded `released-without-sign-in` when that happens. Screen text, help pages and injected page text cannot bench (they only trigger a read or stop one repair).

---

## 2. Under-block

- Wording the judge reads as `signed_out` ⇒ today's behaviour: one repair runs; its page may still be judged (C) or reported by the helper, which stops retries.
- A machine with a single Codex account never benches (the floor needs another account working).
- No Jev key and no second account ⇒ judge `undecided` ⇒ no action (degradation reported).
- If OpenAI enforces only at sign-in and the app-server keeps answering, nothing is benched (correct: the account works).
- Internal Codex routing on a benched default home relies on the existing failure-swap (not changed).

---

## 3. Level-of-abstraction fit

Detectors stay detectors: the session-screen regex and the page origin check only decide WHEN to look. The judge is a model authority over the narrowest, most provider-attributable text (the app-server's reply to `account/rateLimits/read`), fenced as untrusted data. Bench state lives on the existing pool record and is enforced through the existing admission, restore, placement and swap machinery rather than parallel gates. The ledger is bookkeeping (best-effort), not a second authority.

---

## 4. Signal vs authority compliance

Compliant. No brittle check holds blocking authority: regexes only trigger reads; the only blocking effects (bench, repair refusal) flow from a model judgement (Jev + Luna referee, truth table, contradictions ⇒ undecided) with a deterministic floor (two observations, machine floor, budget, fallback to no action). The authority is the judge + pool record; signals are screens, pages, login-status text, initialize errors.

## 4b. Judgment-point check

The bench point is a competing-signals point (provider text vs a working account) and is implemented as a judgment within floors: bounded action, conservative default (`undecided` ⇒ no action), fallback ladder Jev → referee (another account) → deterministic no-op, arbiter = provider (two clean reads) and operator (set-active, ignore list). The stop-one-repair point is likewise judged, with a self-undoing action.

---

## 5. Interactions

- Login-expired recovery: shares capture cadence, tail helper and swap brakes; Claude sessions unchanged. Codex sessions are now captured every 20 s when they carry a pool account.
- QuotaPoller: `pollAll`'s per-account body moved into `pollOne` (shared by `requestCodexCheck`); the restore predicate now reads the pool's current record and adds the device-limit hold. Live Codex reads now go through a per-home single-flight gate (max 2 concurrent).
- Relogin: new failure class `device-limit`; no per-episode notice for it; slow-retry eligible but deferred while suspected/benched and refused by admission while benched; not counted as a helper hard line; `cancelledResult` reports a device-limit ending as terminal.
- Attention: one row per machine (`codex-device-limit:<machineId>`), resolver answers `unknown` for other machines/categories.
- Fixed an environment-dependent unit test (`resolveReloginNavigation` linux cases now pin `wsl=false`; it failed on WSL hosts).

---

## 6. External surfaces

- New outbound data: masked refusal/page text to TypeSafe (Jev) and the Codex fast tier (Luna referee), disclosed in the CLAUDE.md bullet. Secrets scrubbed, emails/names/phones/provider ids masked; full prepared text kept machine-local (0600, gitignored, never served, backup-excluded).
- New fields on `GET /subscription-pool` (`statusCause`, `deviceLimit`); remote rows from older peers report `statusCause: 'unknown'`.
- New Attention row; dashboard cell text; helper prompt gains a fifth hard line.
- Depends on provider wording and timing we do not control; that is why the judge, not a pattern, decides.

## 6b. Operator-surface quality

Dashboard: a benched cell reads "Suspected device limit: benched on this machine" and hides Sign in / Repair, which cannot help (offering it would invite the exact retry the feature exists to stop). The override is conversational (ignore list) by design (round-6 decision: no new signed release mandate). Notice text is plain, names machine and accounts, and says leaving it benched is fine.

---

## 7. Multi-machine posture

machine-local-justification: physical-credential-locality — the limit is enforced per device against the Codex login on that machine's disk. Pool record, ledger episode, bench, provenance and notice are per machine; visible across machines via the existing proxied `GET /subscription-pool?scope=pool`. The new pool fields are excluded from the replicated account-meta projection (tested). One voice per machine by construction (machine id in the condition key).

## 7b. Self-action convergence (`unbounded-self-action`)

Closure: guard (ratchet `tests/unit/self-action-convergence.test.ts`). `deviceLimitSessionMove` is registered in `src/testing/selfActionRegistry.ts`. Moves are serialised with 30 s spacing and each passes the existing `decideLoginExpiredSwap` brakes (one attempt per session per 10 min, at most three). A bench needs two judged refusals 5–60 min apart; device-limit reads back off 1 h → 6 h with a breaker after 8 refusals at the cap. Steady state is zero moves once sessions are off the benched account.

---

## 8. Rollback cost

Live switch `subscriptionPool.codexDeviceLimit.enabled: false`: next poll returns every benched cell to `active`, clears suspicion, drops pending judgements; today's rules decide afresh. Reverting the release: old code ignores the pool fields; an open ledger episode with the unknown cause stays non-actionable until a clean read or set-active — flip the switch off before downgrading. No data migration.

---

## Conclusion

Ships live on development agents (Echo), dark on the fleet until the graduation criterion in the spec's Maturation plan. Every effect reduces autonomy and is reversible; the expensive failure (12 doomed sign-ins per cell) is the one it removes.

## Second-pass review (if required)

**Reviewer:** independent subagent (claude-opus-5-5), read-only, artifact + spec + full source diff
**Independent read of the artifact:** concern → resolved (re-review round 1 found fix 5 not yet applied and fix 4 unbraked; both corrected; re-review round 2 below)

Concerns raised and how each was resolved in this change:
- med — a page-judged stop was a dead end for a merely signed-out account (and the notice said otherwise). Fixed: `device-limit` is on the slow-retry allowlist; the service gate defers it while suspected/benched and admission refuses a benched account; notice text corrected.
- med — the session monitor tick awaited a live Codex read. Fixed: the trigger sink is fire-and-forget; the quiet window is set in a `.then`.
- low-med — callers sharing one single-flight read each hooked it, so one clean read could count twice toward release. Fixed: each underlying read reaches the tripwire once (WeakSet); regression test.
- low — follow-up triggers (initialize error, login status, page stop) were always swallowed by the 10-minute floor. Fixed: a page stop asks for a confirmation-priority read; a trigger-source verdict may bypass the floor at most once per account per 10 minutes (re-review found an unbraked bypass could loop and spend the account's judge budget; braked, with a regression test).
- low — the artifact claimed a settle failure is reported; it was not. Fixed: `ended:false` results raise a `CodexDeviceLimitTripwire.settleRepairs` degradation.
- low — right after a restart the machine floor could raise a false "refusing alike" alarm. Fixed: an unread other account makes the floor `unknown` (logged; no bench, no alarm); regression test.

Checked clean by the reviewer: Signal vs Authority (regexes only trigger reads), the ordinary poll path (no regression for Claude or non-device-limit Codex accounts), text leaks (provenance file only), switch-off across a restart.

## Evidence pointers

- Spec + convergence report: `docs/specs/codex-device-limit-tripwire.md`, `docs/specs/reports/codex-device-limit-tripwire-convergence.md`.
- Tests: see PR (unit: judge, tripwire, mover, session trigger, poller, relogin paths, ledger, pool, reader, login status; integration: routes; e2e: lifecycle).
