# Side-Effects Review — Built-in job templates must authenticate their API calls

**Version / slug:** `evo007-job-template-auth`
**Date:** `2026-07-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required`

## Summary of the change

Five shipped built-in job templates carried a `gate:` line that authenticates correctly, but **prompt bodies** that called authenticated endpoints with a bare `curl -s http://localhost:.../evolution/...`. All 12 of those calls return `401 Missing or invalid Authorization header` at runtime. The gate passing is precisely what hid the failure: the job would wake up, correctly conclude "there is work to do", then read nothing and exit "silently" — indistinguishable from a healthy no-op. A sixth template (`identity-review.md`) defined `AUTH` by reading `.instar/config.json` only, which is broken on any agent whose config token has drifted from the live server token (observed first-hand on this agent: the 16-char config value is rejected, the 36-char `$INSTAR_AUTH_TOKEN` is accepted).

Files touched: six templates under `src/scaffold/templates/jobs/instar/` (`evolution-overdue-check`, `evolution-proposal-implement`, `evolution-proposal-evaluate`, `insight-harvest`, `reflection-trigger`, `identity-review`), plus a new CI lint at `tests/unit/job-template-auth-lint.test.ts`. Each fixed body now resolves the canonical `AUTH` / `AGENT_ID` / `PORT` block (env-first, config fallback) and passes `Authorization: Bearer $AUTH` + `X-Instar-AgentId: $AGENT_ID` on every non-public call.

Two additional defects were found and fixed while in the file, both on the same `reflection-trigger.md` line: the echoed instruction rendered `-d '{type:quick}'` (unescaped inner double quotes were eaten by the enclosing double-quoted `echo`, producing invalid JSON), and it carried no auth. Both are fixed with escaped quoting, verified by executing the echo.

## Decision-point inventory

- `tests/unit/job-template-auth-lint.test.ts` — **add** — a CI lint (build-time signal). It has no runtime surface and cannot gate, delay, or block any agent action.
- Job template bodies — **modify** — these are LLM instructions, not code. They do not make block/allow decisions; they instruct the reading agent which HTTP calls to make.
- `src/server/middleware.ts` `authMiddleware()` — **pass-through** — not modified. The lint mirrors its public-path exemptions and asserts (drift guard) that each exempted path still appears there.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only rejecting surface is the CI lint, and its over-block risk is a false CI failure on a healthy template. This risk **materialized during development and was fixed**: the first draft anchored the `AUTH=` definition check to line-start (`/^\s*AUTH=/m`) and falsely accused three healthy templates (`initiative-digest-review.md`, `mentor-onboarding.md`, `org-intent-drift-audit.md`) that legitimately define `AUTH` inside backticks as a prose step (`0. **Set auth context:** \`AUTH="..."\``). The detector now matches `AUTH=` not preceded by `$` or a word character, and a regression test (`accepts an AUTH definition presented as a prose step in backticks`) pins the fix.

Residual over-block risk: a future template that intentionally calls a non-public endpoint *without* auth (e.g. to demonstrate a 401 in documentation prose) would be flagged. No such template exists today; the fix would be to exempt it explicitly rather than weaken the rule.

---

## 2. Under-block

**What failure modes does this still miss?**

Concrete and acknowledged:

- **Multi-line curl continuations.** The detector scopes a curl invocation to its line. A template using `curl \` + newline + `-H "Authorization: ..."` would have its header on the next line and be flagged (over-block) — or, if the URL is on a later line, the call would not be seen at all (under-block). No shipped template uses continuations; all are single-line.
- **Non-curl HTTP clients.** A template instructing `wget`, `httpie`, or a `node -e` fetch is not scanned at all.
- **Correct header, wrong token.** The lint verifies an `Authorization: Bearer` header is *present*; it cannot verify the token *resolves*. That is exactly the `identity-review.md` failure mode (header present, value stale) — caught here by a separate assertion requiring the env-first `${INSTAR_AUTH_TOKEN:-` form in the six known templates, not by the generic rule.
- **Runtime drift.** A template can be correct at CI time and still 401 at runtime if `$INSTAR_AUTH_TOKEN` is absent from the job environment *and* config.json is stale. The lint cannot see runtime env.
- **Endpoints that become non-public later.** If a currently-public path (say `/ping`) later requires auth, the lint would keep exempting it. The drift guard only catches *removal* of the path from middleware.ts, not a change in its auth posture.

---

## 3. Level-of-abstraction fit

This is a **build-time lint** — the correct layer. The defect is static text in a shipped artifact, fully determinable from source, so it belongs in CI rather than at runtime.

Considered and rejected: a runtime check that inspects job bodies before dispatch. That would be the wrong layer — it would pay a cost on every job run to detect a fault that cannot change after the template ships, and it would need blocking authority to be useful, which the signal-vs-authority principle forbids for logic this brittle.

The lint extends the existing template-validation family (`default-jobs-valid.test.ts`, `PostUpdateMigrator-templateResolution.test.ts`) rather than running parallel to it. It reads its exemption set *from* the real authority (`middleware.ts`) rather than re-deriving one.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The lint is a test. Its only power is failing a build. It holds no authority over any agent at runtime: it cannot block a message, gate a job, delay a session, or constrain a decision. The template edits are instructions to an LLM, not control flow. Nothing in this change can refuse an agent action.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** The question "does this curl carry an Authorization header, and is its endpoint public?" is fully enumerable from source: the public-path set is a finite list read from `authMiddleware()`, and header presence is a textual fact. There are no competing live signals to weigh — no work evidence, liveness, recency, or ownership inputs. This is an invariant check, not a judgment point.

---

## 5. Interactions

- **Shadowing:** None. The lint is an independent test file; vitest runs it alongside the existing template tests with no ordering dependency. It does not shadow `default-jobs-valid.test.ts` (which validates job *structure* from `init.ts`, not template *body content*) — the two cover disjoint surfaces.
- **Double-fire:** None. No runtime component acts on this.
- **Races:** None. The lint only reads files at test time.
- **Feedback loops:** One worth naming explicitly. `evolution-proposal-implement.md` is the template that runs the job that produced this change — the fix is self-referential. It is *not* a loop: the template is data read by a scheduled job, and repairing it changes which HTTP calls a future run makes, not whether this change is correct. Verified by executing the fixed commands directly against the live server rather than trusting the job's own behavior.
- **Migration parity:** `installBuiltinJobs()` (`src/scheduler/InstallBuiltinJobs.ts:127`) unconditionally `writeFileSync`-es every shipped template over the deployed copy, and is called from `PostUpdateMigrator.ts:4046` on every update run. Verified first-hand by reading both call sites. **No separate `PostUpdateMigrator` entry is needed** — and, critically, patching the deployed copies by hand would have been *reverted* at the next update, producing a transient fix indistinguishable from a real one. The durable fix is the source templates, which is what this change edits.

---

## 6. External surfaces

- **Other agents on the same machine:** No change. Templates are per-agent state; each agent receives the fixed copy at its next install/update.
- **Other users of the install base:** Yes, positively — five scheduled jobs that have been silently no-op-ing on every install will begin functioning. Anyone who had these jobs enabled gets working evolution/insight/reflection/identity jobs. Worth calling out in release notes: behavior that appeared "quiet and healthy" will start producing real output.
- **External systems:** None. All calls are to `localhost`.
- **Persistent state:** None added. The jobs will now successfully write to existing stores (evolution proposals/actions/learnings, reflection records) that they were previously failing to reach — that is the intended repair, not a new surface.
- **Timing / runtime conditions:** The fix depends on `$INSTAR_AUTH_TOKEN` being present in the job environment (verified present, 36 chars) with config.json as fallback.
- **Operator surface (Mobile-Complete Operator Actions):** No operator-facing actions added or touched. This change adds no route, form, approval, or grant.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

**No operator surface — not applicable.** No dashboard renderer, markup file, approval page, or grant/revoke/secret-drop form is touched. The change is confined to shipped job-template markdown and a test file.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, with reason: job templates are installed onto each machine's own `.instar/jobs/instar/` by that machine's own `installBuiltinJobs()` run, and the auth token they resolve (`$INSTAR_AUTH_TOKEN` / that machine's `config.json`) is **necessarily** machine-local — each install holds its own `authToken`, and a shared token cannot work cross-machine. Replicating template content or tokens across machines would be actively wrong.

Every machine converges on the same fixed template content through the same update path, so there is no divergence risk: this is not "machine-local state that should have been replicated", it is identical shipped content resolved against per-machine credentials.

- **User-facing notices:** None emitted by this change. (The *jobs* may now emit notices they previously failed to produce, but each job's own one-voice/topic-routing behavior is unchanged by this fix.)
- **Durable state on topic transfer:** None held. Nothing strands on a topic move.
- **Generated URLs:** None generated. All URLs are `localhost` calls made by the job on its own machine, which is correct — they are never shared or sent to a user.

---

## 8. Rollback cost

- **Hot-fix release:** Revert the six template files and the test; ship as a patch. Existing agents pick up the reverted content at their next update via the same `installBuiltinJobs()` overwrite path.
- **Data migration:** None. No schema, column, or persistent state introduced.
- **Agent state repair:** None required.
- **User visibility during rollback:** Reverting restores the *previous broken behavior* (jobs silently no-op again). No error state, no crash, no data loss — the pre-fix behavior was quiet failure, so a rollback is quiet too. That asymmetry is itself the argument for why this class of bug survived so long.

Rollback risk is minimal: worst case is a return to the status quo ante.

---

## Conclusion

This review produced two changes to the work in progress. First, the lint's `AUTH=` detector was rewritten after it falsely accused three healthy templates — a real over-block caught before commit, now pinned by a regression test. Second, the scope grew by two genuine same-class defects found by reading rather than assuming: `identity-review.md`'s config-only token read (broken on this very agent, proven by executing both tokens against the live server) and `reflection-trigger.md`'s quote-mangled JSON body.

The change is clear to ship. It has no runtime authority, no persistent state, no operator surface, and a trivial rollback. The verification is first-hand rather than proxy: the lint was proven to report **exactly** the 12 pre-fix violations when run against the original content from `HEAD` and zero after, and the fixed commands were executed against the live server returning real data instead of 401.

One honest limitation, stated rather than buried: the lint verifies an auth header is *present*, not that its token *resolves*. Token-resolution correctness is covered for the six known templates by the env-first assertion, but a future template could pass the lint and still 401 with a stale token. Closing that would require a runtime check, which is the wrong layer for the reasons in §3.

---

## Second-pass review (if required)

**Reviewer:** not required.

Phase 5 triggers on changes touching block/allow decisions on messaging or dispatch, session lifecycle, context/compaction, coherence gates, trust levels, or any sentinel/guard/gate/watchdog. This change touches none of them: it is shipped instruction text plus a CI lint with no runtime surface. The word "gate" appears in the templates' `gate:` frontmatter field, but those lines are **not modified** by this change.

---

## Evidence pointers

- **Lint bites (pre-fix):** running the detector against the six original files extracted from `HEAD` reported exactly 12 unauthenticated calls — `evolution-overdue-check` 3, `evolution-proposal-evaluate` 3, `evolution-proposal-implement` 2, `insight-harvest` 3, `reflection-trigger` 1 — matching the independently-derived census. Post-fix: 0.
- **Live 401 → 200:** `curl` to `/evolution/proposals?status=approved` with no header returns `{"error":"Missing or invalid Authorization header"}`; the fixed template's resolved command returns the real proposal list. Same confirmed for `/evolution/learnings?applied=false` and `/evolution/actions/overdue`.
- **Stale-config proof:** the 16-char `config.json` token returns `{"error":"Invalid auth token"}`; the 36-char `$INSTAR_AUTH_TOKEN` succeeds — the concrete reason `identity-review.md` needed the env-first form.
- **Quoting proof:** executing the original `reflection-trigger.md` echo renders `-d '{type:quick}'` (invalid JSON); the fixed line renders `-d '{"type":"quick"}'` with the token name left unexpanded so no secret enters the transcript.
- **Migration parity:** `InstallBuiltinJobs.ts:127` unconditional overwrite, reached from `PostUpdateMigrator.ts:4046`.
- **Tests:** `tests/unit/job-template-auth-lint.test.ts` (9 tests) green; template-family tests (`refresh-jobs`, `default-jobs-valid`, `PostUpdateMigrator-templateResolution`) green.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `novel` is *not* claimed. This is an instance of the existing **unverified-claim / proxy-signal** family already tracked by EVO-004 (ACT-930), EVO-005, and EVO-006 (ACT-985): a signal adjacent to the real terminal state (the `gate:` passing, "the job ran quietly") was treated as evidence of the terminal state (the job actually did its work). Recorded here as `defectClass: proxy-signal-substitution`.
- **`closure`** — `guard`.
- **`guardEvidence`** — `{enforcementType: lint, citation: tests/unit/job-template-auth-lint.test.ts#"every shipped template authenticates its non-public API calls", howCaught: the lint scans every shipped template body for curl calls to non-public endpoints lacking an Authorization header and fails the build; run against the pre-fix content it reports exactly the 12 violations that shipped, so this defect could not have reached main with the guard in place}`.
- **`gap`** — none for the template-text class. The broader "a job that silently no-ops looks identical to a healthy quiet job" class is **not** closed by this change and remains tracked under the EVO-005/EVO-006 family; this fix closes only the specific mechanism (missing auth header in shipped template text).
