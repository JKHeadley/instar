# Side-Effects Review — Canonical job source must authenticate too (EVO-007 follow-up, ACT-620)

**Version / slug:** `evo007-canonical-source-auth`
**Date:** `2026-07-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required`

## Summary of the change

PR #1636 fixed the shipped `.md` job templates. This fixes the thing that **generates** them. `src/scaffold/templates/jobs/instar/*.md` are produced from `getDefaultJobs()` in `src/commands/init.ts` by `scripts/regen-default-job-templates.mjs`, so the previous fix was applied to generated output while the generator's input stayed broken — a regen would have silently reverted it. That is precisely the "fix that only looks like a fix" this family of defects keeps producing, and it was caught by reading the generator rather than trusting the previous PR's completeness.

Changes:

1. **13 unauthenticated calls** in canonical job definitions now carry `Authorization: Bearer $AUTH` + `X-Instar-AgentId`. Twelve mirror PR #1636; the thirteenth — `feedback-retry` → `POST /feedback/retry` — was **found by the new guard**, not by me, and confirmed live as a 401.
2. **12 config-only token reads** (`AUTH=$(python3 … config.json …)`) replaced with the env-first `${INSTAR_AUTH_TOKEN:-…}` form across `reflection-trigger`, `memory-export`, `capability-audit`, `identity-review`, `commitment-detection`, and six CLAUDE.md-template instruction blocks. A config-only read is a live defect on any agent whose stored token has drifted from the running server's.
3. **ACT-620's blind activity digest** fixed in both callsites. The shipped jq was worse than reported: in the `.md` it is a **jq compile error** (interpolation backslashes lost), silenced by `2>/dev/null`, so every reflection ran on an empty digest. The filter also excluded `job-start`/`job-queued`, which never occur — the real types are `job_triggered` / `job_gate_skip` / `job_skipped` — and the text slot read `.message`/`.title`/`.session_name`/`.slug`, none of which are keys; the real ones are `.summary` and `.metadata.slug`. Now filters the real noise types, reads the real keys, and adds a volume summary so the reflection sees job activity without it eating the 100-line budget.
4. **The lint now covers the canonical source**, by resolving `getDefaultJobs(4042)` and linting the real `gate` + `execute.value` strings.

## Decision-point inventory

- `tests/unit/job-template-auth-lint.test.ts` — **modify** — extended to the canonical source. Still a CI lint: build-time only, zero runtime authority.
- `getDefaultJobs()` job bodies — **modify** — LLM instruction text and shell one-liners. No block/allow logic.
- No runtime module, route, gate, or sentinel is touched.

---

## 1. Over-block

The only rejecting surface is the lint. Its over-block risk is a false CI failure.

Notably, the **first version of the canonical-source guard was worse than a false positive — it was a false NEGATIVE**: it regexed the raw `init.ts` text, whose bodies contain `localhost:\${INSTAR_PORT:-${port}}`, which the detector's `\d+`/`$PORT` pattern never matched. It passed **vacuously** while the source was fully broken. Caught by running the detector against the pre-fix source and seeing it report nothing where an independent probe found violations. Fixed by linting the *resolved* job objects instead of the file text, plus an explicit `expect(jobs.length).toBeGreaterThan(10)` so an empty/failed resolution can never read as "clean".

Scoping the lint to resolved job objects also removes a real over-block: `init.ts` embeds the CLAUDE.md template prose, which contains illustrative `curl` examples that are documentation, not job bodies. Linting the whole file flagged 52 of those.

---

## 2. Under-block

- Same line-scoped-curl and non-curl-client limits as PR #1636.
- The lint verifies a header is *present*, not that the token *resolves*; the config-only rule covers the known stale-token shape but a novel wrong-token expression would pass.
- **The `.md` files and `init.ts` are still not byte-compared.** The auth/token class is now closed on both sides, but general drift is not — tracked as **ACT-1263** <!-- tracked: ACT-1263 -->.
- The jq fix is verified against this machine's activity logs. A log containing event types not present here would still be filtered by name.

---

## 3. Level-of-abstraction fit

Correct layer, and this change *moves* the guard to the right layer: the previous lint sat on the generated artifact, one level below where the defect is authored. Linting the generator's resolved output is the level at which "a shipped job body must authenticate" is actually decidable.

Resolving `getDefaultJobs()` rather than regexing the source is the same principle applied again — ask the system for its real answer instead of pattern-matching its text.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The lint can only fail a build. The job bodies are instructions and shell strings with no decision logic. Nothing here can refuse an agent action at runtime.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** "Does this resolved job body call a non-public endpoint without an auth header?" is an invariant over a finite, enumerable public-path set. No competing live signals.

The jq event-type filter is a static list, but it is not a decision point either — it selects log lines for a human-readable digest, and a mis-filtered line degrades digest quality, never a decision.

---

## 5. Interactions

- **Shadowing:** None. The lint file is independent.
- **Double-fire:** None.
- **Races:** None.
- **Feedback loops:** `reflection-trigger`'s digest feeds an LLM reflection that may write MEMORY.md. Fixing the digest changes that input from *empty* to *real*, which is the intent; the digest is bounded (`tail -100` plus a type-count summary) so it cannot grow unbounded.
- **Generator interaction (the important one):** `regen-default-job-templates.mjs` writes `.md` from these bodies. Because the canonical source is now fixed, a regen propagates the fix instead of reverting it. Verified via `--dry-run`, which lists all five previously-fixed templates as regeneration targets — the concrete proof the prior fix alone was revertible.

---

## 6. External surfaces

- **Other users of the install base:** 13 job bodies that silently 401'd will start working, and reflection digests go from empty to populated. Same "quiet becomes active" note as PR #1636.
- **External systems:** none; all calls are localhost.
- **Persistent state:** none added.
- **Secrets:** the reflection echo deliberately emits `$INSTAR_AUTH_TOKEN` **unexpanded**, so no token value enters a transcript. Verified by executing the generated line.
- **Operator surface:** none added or touched.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

**No operator surface — not applicable.** No dashboard renderer, approval page, or grant/secret form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, same reason as PR #1636: templates are installed per machine by that machine's own `installBuiltinJobs()`, and the token each body resolves is necessarily machine-local (every install holds its own `authToken`; a shared token cannot work cross-machine). Identical shipped content resolved against per-machine credentials — not machine-local state that ought to be replicated.

- **User-facing notices:** none emitted by this change.
- **Durable state on topic transfer:** none held.
- **Generated URLs:** none; all are localhost calls made by the job on its own machine.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit; agents pick it up on their next update.
- **Data migration:** none.
- **Agent state repair:** none.
- **User visibility during rollback:** reverting restores quiet failure — no crash, no data loss. Same benign asymmetry as PR #1636.

---

## Conclusion

This review's main product is the correction of my own guard. The canonical-source lint initially passed vacuously — the worst failure mode available to a check, because a vacuous pass is indistinguishable from a real one and would have shipped as false assurance. Testing the guard against the pre-fix source (rather than only against the fixed tree) exposed it, and the rewrite to lint resolved job objects then immediately earned its place by finding a 13th defect, `feedback-retry`, that I had not known about.

The change is clear to ship. The remaining known gap — general byte-parity between generated templates and their source — is tracked as ACT-1263 rather than folded in, because reconciling all 14 generated templates is a distinct change with its own review surface.

---

## Second-pass review (if required)

**Reviewer:** not required. No block/allow surface, no session lifecycle, no context/compaction, no coherence/trust surface, and no sentinel/guard/gate/watchdog runtime component. The only "gate"-adjacent text is the `gate:` frontmatter field, whose *content* is edited but whose evaluation semantics are untouched.

---

## Evidence pointers

- Guard proven to bite: with `init.ts` reverted to `origin/main`, the canonical-source test fails listing 13 unauthenticated calls across `reflection-trigger`, `feedback-retry`, `insight-harvest`, `evolution-overdue-check`, `evolution-proposal-evaluate`, `evolution-proposal-implement`; the config-only-token test fails with 12. Both pass on the fixed tree.
- Live 401 → 200 for the newly-found endpoint: unauthenticated `POST /feedback/retry` → `{"error":"Missing or invalid Authorization header"}`; authenticated → `{"ok":true,"retried":0,"succeeded":0}`.
- Shipped jq proven to be a compile error against a real activity log; corrected jq emits real `scheduler_start`/`scheduler_stop` rows with summaries, and the volume summary reports `462 job_triggered / 33 job_gate_skip / 3 scheduler_start / 2 scheduler_stop`.
- Real log key/type census: top-level keys are `type`, `timestamp`, `summary`, `metadata`, `sessionId` (never `message`/`title`/`session_name`/`slug`); types are `job_triggered`, `job_gate_skip`, `job_skipped`, `scheduler_start`, `scheduler_stop` (never `job-start`/`job-queued`).
- Generated bash for the reflection echo extracted from the resolved job object and executed: renders `-d '{"type":"quick"}'` with `$INSTAR_AUTH_TOKEN` unexpanded.
- `tsc --noEmit` clean; lint (11 tests), `default-jobs-valid`, `refresh-jobs` green.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `proxy-signal-substitution` (the same class as PR #1636 and the EVO-004/005/006 family): the generated artifact was treated as the thing to fix, when the generator's input is what determines what ships.
- **`closure`** — `guard`.
- **`guardEvidence`** — `{enforcementType: lint, citation: tests/unit/job-template-auth-lint.test.ts#"the canonical source (getDefaultJobs) authenticates its non-public API calls", howCaught: it resolves getDefaultJobs(4042) and lints the real gate + prompt bodies, so an unauthenticated call cannot enter the canonical source that generates the shipped templates; run against the pre-fix source it reports all 13, and a sample-size assertion prevents a vacuous pass}`.
- **`gap`** — `ACT-1263` for the remaining general byte-parity between generated templates and their generator source, which this change does not close.
