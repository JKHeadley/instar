# Side-Effects Review — Routing Control Room PR 4 (operator additions)

**Spec:** `docs/specs/routing-control-room-spend-alerts.md` (review-convergence r7, approved, parent-principle: Token-Audit Completeness) — FD-7 deferral resolved by the operator + FD-8 web-verify, both operator decisions 2026-07-07 (topic 29723).
**Worktree:** `echo/money-increment-pr4` off `JKHeadley/main` @ `d70a546f8` (contains merged Increments B, C, and Layer 1c).
**Scope (PR 4 of the train, tracked CMT-1929 — the FINAL increment):** the two operator additions.

## Phase 1 — Principle check (signal-vs-authority)

**Does this change involve a decision point?** No blocking decision anywhere. The amortized display is REPORTING-only arithmetic over an operator-declared config value; the web-verify parsers write OBSERVATIONS into the gate-ineligible observed cache, and their failure mode is REFUSAL (no data) — never a wrong price entering any gate path. Compliant.

## Phase 2 — Plan

- **Decision points touched:** none with authority. The web-verify parsers DECIDE only whether a page is confidently parseable (fail-closed both ways: unparseable → no point; implausible vs canonical → refused).
- **Existing detectors/authorities interacted with:** `RoutingPriceAuthority` (unchanged — the observed cache remains gate-ineligible by construction); the FD-8 budget refusal (narrowed: the DETERMINISTIC `+web-verify` scope is exempt because it spends nothing — no LLM, no metered key; metered probes stay budget-fail-closed); `SCRAPE_PARSERS` (both parsers registered with REAL captured fixtures per the Fixture Realness standard); `installBuiltinJobs` (the new template reaches existing agents on update — Migration Parity by the existing non-destructive install path).
- **Rollback path:** additive; remove the config key / leave the job disabled and behavior reverts byte-for-byte. The fixtures and job template are inert.

## Phase 4 — Side-effects review (rider content, reviewed)

The operator additions land here as the train's final increment (both operator decisions 2026-07-07, topic 29723):

1. **Amortized subscription display ("amortize but show the math"):** `routingSpend.subscriptions` (reporting-only config — never a gate input) declares a monthly price per CLI door; the composer amortizes by CALENDAR TIME over the door's ACTIVE days in the window (30.4375 avg-month constant, NAMED in the output) and emits the full `amortizationDerivation` string per door; totals count each door once; the Spend tab renders the amortized figure with the math as a visible footnote block. Undeclared doors keep the honest `$0 (subscription — not per-token billed)`. Over-block: none (display only). Under-block: an operator-declared wrong price shows wrong REPORTING — labeled as door-level calendar allocation, never cap-enforced.
2. **Scheduled web-research price checks:** `--scope +web-verify` in the deterministic prober — fetches the OFFICIAL Groq + Google pricing pages (the two doors without machine-readable price APIs), extracts tracked-model prices with CONSERVATIVE fail-closed parsers (registered in SCRAPE_PARSERS; fed the REAL captured page bytes per the Fixture Realness standard) plus a plausibility clamp (>10x off the reviewed canonical → refused). Zero spend (no LLM, no metered key — the FD-8 budget refusal now exempts exactly this deterministic scope; metered probes stay budget-fail-closed). Observations only; PIN promotion unchanged. New OFF-by-default job template `routing-price-web-verify` (weekly, tier-1 supervised, Bash-only).

Signal-vs-authority: both riders are reporting/observation surfaces with zero blocking authority; the web-verify parsers' failure mode is REFUSAL (no data), never a wrong price entering the gate path (observed cache is structurally gate-ineligible).

5. **Interactions:** the amortized figure never feeds netUsd/grossUsd/committed (a separate labeled column + totals line, counted once per door); the web-verify observations ride the EXISTING forward-only merge + promote-me drift surface — no new interaction with the money layer. 6. **External surfaces:** two outbound HTTPS fetches to official public pricing pages from an OFF-by-default weekly job; no data leaves the machine. 7. **Multi-machine:** the observed cache stays machine-local BY DESIGN (declared in the sibling job); the subscriptions config is per-machine reporting (the pool-merge label already names the adjustments source). 8. **Rollback cost:** config/job revert; no state migration.

## 6b. Operator-surface quality

The one operator surface touched is the Spend tab's subscription-cost display (a READ surface — no new controls, no forms). Answered in writing:
1. **Leads with its primary action?** Yes — the tab's primary content is unchanged (the spend headline + rows); the amortized figure lands IN the existing Net column where the operator already looks, as `~$13.14 amortized ⓘ` — a value, not a control.
2. **Zero raw internals as primary content?** Yes — the derivation math is a hover title + a compact footnote block BELOW the table, in plain sentences ("$200.00/mo ÷ 30.4375 avg days/mo = $6.5708/day × 2 active day(s) = ..."), never JSON or config keys; the config key itself appears nowhere on the surface.
3. **Destructive actions de-emphasized?** N/A — the change adds no actions at all (display only); the existing tab's control asymmetry (freeze easy, arm PIN-gated) is untouched.
4. **Plain language at phone width?** Yes — one short suffix per row plus a wrapping footnote paragraph; no new table columns (phone tables were the 2026-06-12 lesson), no horizontal growth; the ⓘ affordance signals the hover/footnote for touch users who cannot hover.

## Phase 5 — Second-pass review

Not-required by the Phase-5 trigger list (no block/allow decisions, no session lifecycle, no gate/sentinel authority — display arithmetic + fail-closed observation parsers). The parsers' realness posture is enforced by the SCRAPE_PARSERS lint rather than reviewer eyes.

## Self-action convergence (unbounded-self-action — closure: n/a)

No new self-triggered loop: the web-verify job is a fixed-cadence, OFF-by-default scheduled job (calendar-driven, not feedback-driven — its output never changes its input), and the display change has no emission at all. Declared n/a: one-shot/cadenced observation work, not a self-triggered controller.

## No-deferrals accounting

This is the train's final increment; the pool-scope reconciliation merge remains the one tracked follow-up under CMT-1929 <!-- tracked: CMT-1929 -->.

## S2-2 hardening round (post-CI, staged with this fix)

CI's string-level S2-2 ratchet (`the prober source never names routing-prices.manifest.json`) caught the plausibility clamp's `readManifest` naming the canonical manifest in CODE — a genuine violation of the prober's structural manifest-blindness, not just a comment. Fixed by inverting the dependency: the prober now takes a generic READ-ONLY `--plausibility-baseline <path>` argument (absent → the clamp passes, no baseline), and the CALLER (the web-verify job template) passes the manifest's location. The prober source contains zero references to the reviewed price file; write-incapability is preserved by construction; the clamp behavior is unchanged (verified: sane passes, >10x refused, no-baseline passes).
