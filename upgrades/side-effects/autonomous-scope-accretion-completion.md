# Side-Effects Review — Autonomous Scope-Accretion Completion Discipline

**Version / slug:** `autonomous-scope-accretion-completion`
**Date:** `2026-07-02`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 2 — converged + approved spec drives the change; 7-round convergence incl. cross-model codex-cli:gpt-5.5)`

## Summary of the change

Implements `docs/specs/autonomous-scope-accretion-completion.md` (converged + approved): the autonomous-session completion judge refuses `met:true` while in-scope artifacts the session itself drafted sit unbuilt without operator ratification. All load-bearing facts are computed SERVER-SIDE at the existing `POST /autonomous/evaluate-completion` chokepoint from git truth + server-owned state (never session-transported): a new `AutonomousRunStore` (server-owned run records under `state/autonomous-server/`), `ScopeAccretionSweep` (read-only git-truth sweep over live-derived roots), `ScopeAccretionCorroboration` (per-class deterministic built/delivered evidence: ceremony-record+report, merged-PR predicate, positive-only local-git shortcut), `ScopeAccretionRatifier` (conversational ratification at the live Telegram receive path), four new routes (`POST /autonomous/register`, `POST /autonomous/:topic/run-end`, PIN-gated `ratify-deferral` + `scope-accretion-override`), a deterministic pre-judge HOLD in evaluate-completion with a persisted K=3 breaker and a loud labeled exit, run-end enumeration on EVERY exit surface, advisory layers (hook Layer-B vocabulary scan + PostToolUse `file_path` ledger on both template copies + Codex PostToolUse group), config defaults/types, CLAUDE.md template + migrator parity (marker bump REALCHECK_VERIFY → SCOPE_ACCRETION across hook/setup/SKILL.md), WorkingSetManifest nomination of the new store, and the three-tier test suite with captured-fixture-registered parsers.

Files: `src/core/{AutonomousRunStore,ScopeAccretionSweep,ScopeAccretionCorroboration,ScopeAccretionRatifier,CompletionEvaluator,PostUpdateMigrator,WorkingSetManifest,installCodexHooks,types}.ts`, `src/server/{routes,specReviewRoutes}.ts`, `src/messaging/TelegramAdapter.ts`, `src/lifeline/TelegramLifeline.ts`, `src/config/ConfigDefaults.ts`, `src/commands/init.ts`, `src/scaffold/templates.ts`, `scripts/lint-scrape-fixture-realness.js`, `.claude/skills/autonomous/{SKILL.md,hooks/autonomous-stop-hook.sh,scripts/setup-autonomous.sh}`, site docs, and tests (unit ×6 files, integration, e2e).

## Decision-point inventory

- `POST /autonomous/evaluate-completion` (routes.ts) — modify — gains the deterministic scope-accretion pre-judge gate (R25), server-resolved arming (R35), registered-condition authority (R36), runId pair check, breaker, and met-terminality recording. Fail direction on EVERY new path: `met:false` (keep working); a sweep failure degrades to judge-only, never a false done.
- `POST /autonomous/register` (routes.ts) — add — server-side start snapshot; endAt clamped; one registration per active run (409 conflict).
- `POST /autonomous/:topic/run-end` (routes.ts) — add — best-effort exit enumeration; never blocks the exit.
- `POST /autonomous/:topic/ratify-deferral` + `POST /autonomous/:topic/scope-accretion-override` (routes.ts) — add — dashboard-PIN-gated operator authority (checkMandatePin); Bearer alone is structurally insufficient.
- `parseStopSignals` (routes.ts) — modify — whitelists exactly ONE new client field (`scopeAccretionSuspected`, advisory boolean); blocking inputs are computed in-route by construction.
- `CompletionEvaluator` prompt (CompletionEvaluator.ts) — modify — field-gated context lines only; PROMPT_VERSION bumped v2→v3 with canary tests; a payload without the new fields renders a byte-identical prompt.
- Telegram receive path (TelegramAdapter.processUpdate + `/internal/telegram-forward`) — modify — fire-and-forget `onScopeAccretionInbound` observer AFTER auth gating; a throwing observer never blocks routing.
- Autonomous stop hook — modify — Layer-B advisory scan (fenced/quoted-excluded), topicId/runId echo, run_end_call on every terminal exit surface; all best-effort `-m`-bounded, never delaying the exit.
- Hook-event reporter payload (init.ts + PostUpdateMigrator.ts template copies) — modify — adds optional `file_path` (designed-benign; receiver tolerates absence), reconciling the pre-existing `cwd` divergence.
- Conformance-check route (specReviewRoutes.ts) — pass-through + persistence hook — records invocations by slug (R32 ceremony evidence); best-effort, a miss only delays clearing.

---

## 1. Over-block

The hold can fire on a deliverable-class artifact the session created that a human would consider legitimately deferred. This is the designed behavior (Deferral = Deletion) and is bounded three ways: declared deliverables at setup never hold; the operator ratifies in one reply or one PIN call; and the K=3 breaker guarantees a bounded, loud exit — never a wedge. A false hold from a stray local branch in the run's own roots is breaker-bounded (spec R48 names this as the safe direction). Shared agent-home roots are attributed HEAD-only so concurrent sessions' work cannot hold this run. `docs/specs/reports/**` is excluded from the deliverable taxonomy so clearing a spec cannot accrete a new hold (self-feeding loop closed). Duration expiry and emergency stop are untouched — a session can never be trapped past `end_at`.

## 2. Under-block

Named residuals per spec §6, all accepted and stated: out-of-root writes (advisory-flagged only when the ledger saw them); non-HEAD branches of the SHARED root (corroboration's merged-PR arm still sees the normal PR path); docs-PR bundling above the ≥10-line non-docs floor (deterrence bound — a merged PR is public + attributable); artifacts outside the glob taxonomy (TODO scaffolds, code stubs — v1 blocking taxonomy is a docs/spec/script discipline, unlisted docs get the advisory flag); same-machine tamper of server state (tamper-class, not workflow-class — the R12 bound). Post-trip the gate disengages for the run — abandonment after K holds is possible but only LOUDLY (the honest ceiling; requiring ratification to release the breaker would reintroduce the wedge).

## 3. Level-of-abstraction fit

Correct layer by construction (this was the spec's central design fight, R11/R25): the accretion hold is a DETERMINISTIC invariant, so it is enforced deterministically at the server route — not paraphrased into the judge prompt as if it were judgment. The judge (the existing smart gate) receives the facts as advisory context on the met-path only. The detection substrate is git truth (P20: the file in the tree is the state), not tool events (path-less, Bash-bypassable) and not transcript scans (tail-blind, forgeable). The hook's Layer-B scan is explicitly a signal (advisory boolean) feeding the existing judge, never an authority.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no NEW brittle blocking authority: the blocking decision is a deterministic server-side invariant over git state + server-owned records (exact-match facts, not vocabulary matching), in the established fail-safe direction (`met:false` = keep working, which is the non-destructive direction for an autonomous run; the exit is never wedged thanks to the breaker + duration expiry). All vocabulary/pattern matching in the change (Layer-B scan, defer-trigger detection) is SIGNAL-only: the Layer-B boolean feeds the judge as context; a defer-trigger only causes the server to ASK the operator (an enumeration message), never to act. The one path that pushes toward exit — ratification — is anchored to a verified principal confirming a server-authored enumeration (message-id chain), or the PIN route.

## 5. Interactions

- **Shadowing:** the pre-judge gate runs BEFORE the completion judge and before the live-test veto. A hold returns early — the judge/live-test never run on that evaluation (intended: the LLM call is not spent on a deterministically-refused claim). The live-test veto still runs on every met-path verdict; met-terminality is recorded only on the verdict that actually leaves the handler as met:true (the veto can still flip it).
- **Double-fire:** run-end enumeration + the R28b daily-sweep backstop could both enumerate the same run; the attention item id (`scope-accretion-exit-<topic>-<runId>`) dedupes at the attention layer, and `markTerminal` is one-way (first exit wins; a terminal record is skipped by the daily sweep's active-only reap).
- **Races:** AutonomousRunStore is single-writer (the server process) with atomic tmp+rename writes; the breaker read-modify-write happens within one request handler. The Telegram observer is fire-and-forget and only appends to server-owned records via the store's update funnel.
- **Feedback loops:** clearing evidence (reports under `docs/specs/reports/`) is excluded from the sweep taxonomy, so corroborating an artifact cannot create a new held artifact. Enumerations are deduped per unbuilt-set hash so an unchanged set never re-sends (bounded by the breaker regardless).

## 6. External surfaces

- **Telegram:** two new server-authored message shapes (the ratification enumeration; the run-end/breaker enumeration) plus attention items — all topic-scoped, deduped, clamped (50 paths + "and N more"). No new topics are created (rides existing sendToTopic/createAttentionItem, subject to the existing topic-flood budgets).
- **GitHub (`gh`):** corroboration adds ONE batched merged-PR query per evaluation on the judge path only, `-m`-bounded (10s budget), negatives TTL-cached 5 minutes, positives persisted monotone. A network failure degrades to keep-working with `corroborationDegraded` named.
- **Persistent state:** new server-owned dir `state/autonomous-server/` (run records, advisory JSONL ledger, session map, conformance-invocation records) with archive lifecycle (R28) and WorkingSetManifest nomination (archived records excluded). Audit discipline per spec §4: uid HASHES, message ids, path basenames — never message bodies.
- **Other agents/frameworks:** the reporter-payload `file_path` extension is designed-benign (receiver stores extra fields; 3-field payload remains valid); Codex gains an advisory PostToolUse group; gemini/pi are advisory-absent (named). The guarantee fires only for engines whose loop consults the chokepoint (Claude today) — honest coverage bound per R16.
- **Operator surface (Mobile-Complete Operator Actions):** both operator actions are phone-completable — the conversational ratification is a Telegram reply; the enumeration message carries the dashboard deep link to the PIN-gated ratify surface; the override is a PIN route reachable from the dashboard's existing PIN-auth pattern. No terminal-only path is introduced.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer/markup file is touched by this change — the operator surfaces are the Telegram enumeration message (leads with the question + exact artifact list + one-line reply instruction + the dashboard link; no raw internals beyond repo-relative paths, which ARE the content) and two PIN-gated API routes consumed via that link. Criteria: (1) the enumeration leads with the primary action ("Ratify deferring these N artifacts?"); (2) no JSON/UUIDs — repo-relative paths only; (3) no destructive action on the surface (ratification is the constructive primary; there is nothing to de-emphasize); (4) plain language, short lines, phone-first (a Telegram reply IS the phone path). A dedicated dashboard ratify FORM is a follow-up polish, not a blocker: the reply path + deep link make the action mobile-complete today.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN, with working-set carriage** — a run executes on one machine, so its server run record + advisory ledger are machine-local truths (spec §4 declares this posture explicitly). On topic transfer the records ride the working-set carrier: `WorkingSetManifest.computeWorkingSet` now nominates `state/autonomous-server/<topic>.*` (archived records excluded). Signals are recomputed per evaluation, so nothing durable strands. User-facing notices route through the existing per-topic send path (one-voice gating unchanged). No URLs are generated beyond the localhost dashboard deep link, which is machine-correct by construction (the run's own server mints it).

## Evidence pointers

- Spec (converged 7 rounds, cross-model codex-cli:gpt-5.5, approved): `docs/specs/autonomous-scope-accretion-completion.md` + `.eli16.md` + `docs/specs/reports/autonomous-scope-accretion-completion-convergence.md` (committed 7938566e9).
- Unit: `tests/unit/{autonomous-run-store,scope-accretion-sweep,scope-accretion-corroboration,scope-accretion-ratifier,autonomous-stop-hook-scope-accretion}.test.ts` + updated `CompletionEvaluator*.test.ts` — 106 tests green.
- Integration: `tests/integration/scope-accretion-routes.test.ts` — 20 tests green (register/hold/ratify/override/run-end round-trips, auth contracts, degraded corroboration).
- E2E (feature-alive, the required evasion-shaped case): `tests/e2e/scope-accretion-lifecycle.test.ts` — 5 tests green, incl. the Bash-heredoc spec + met-looking transcript that does NOT exit until ceremony-corroborated, and the loud labeled breaker exit.
- Captured-fixture realness: 6 parsers registered in `scripts/lint-scrape-fixture-realness.js` with byte-for-byte fixtures under `tests/fixtures/captured/scope-accretion-*/` — lint green.
- `tsc --noEmit` clean; full unit suite green at commit.
