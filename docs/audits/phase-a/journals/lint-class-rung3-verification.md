# Lint-class guards — rung-3 verification by two-sided injection

**Measured 2026-08-04 08:35–08:59Z, Mac Mini**, against
`.worktrees/memory-pressure-metric-sibling` (HEAD f4500c969). **Every script tested was first diffed
against `origin/main` and found UNCHANGED**, so these verdicts are of shipped code, not a stale checkout.

## Population note — this does NOT re-score the 90

The 30 `scripts/lint-*.js` guards are a **separate inventory** from the 90 runtime guards on `/guards`
(which are `monitoring.*`-style config flags). **Verifying lints adds ground truth alongside the
"20 of 90 confirmed" baseline; it does not improve it.** Conflating the two would inflate the headline.

## Method (stable, ~2 min/guard)

1. `git diff HEAD origin/main -- <script>` → **must be empty**.
2. Baseline run → **must be exit 0**.
3. **Read the detection pattern from source.** Never infer the violation shape.
4. Inject **A** (violation) → expect **1**. Inject **B** (compliant) → expect **0**.
5. Delete/`git checkout` → **assert worktree back to 0 changes.**

> **B is non-negotiable.** Without it, a catch cannot be distinguished from a guard that rejects
> everything.

## Verified `effective: TRUE` — 18 of 30

| # | guard | standard / purpose | B (compliant form that must pass) |
|---|---|---|---|
| 1 | `lint-llm-attribution` | Observability — every LLM call attributed | valid `attribution.component` |
| 2 | `lint-dev-agent-dark-gate` | User-Facing Fixes Ship Live | `resolveDevAgentGate(...)` |
| 3 | `lint-no-direct-destructive` | destructive-op funnel | `SafeFsExecutor.safeRmSync` |
| 4 | `lint-no-unbounded-llm-spawn` | fork-bomb prevention | `buildIntelligenceProvider()` |
| 5 | `lint-sync-subprocess-chokepoint` | event-loop protection | `withSyncOp(...)` |
| 6 | `lint-no-blocking-process-scans` | no `ps`/`lsof` on hot path | async scan |
| 7 | `lint-no-direct-url-log` | credential-in-URL leak | `redactUrl()` |
| 8 | `lint-no-unfunneled-credential-write` | credential-write serialization | `writeCredentialsSerialized` |
| 9 | `lint-no-unfunneled-topic-creation` | Bounded Notification Surface | adapter funnel |
| 10 | `lint-no-unfunneled-headless-launch` | June-15 billing lane | `spawnReroutedInteractive` |
| 11 | `lint-no-direct-llm-http` | no direct provider HTTP | provider funnel |
| 12 | `lint-no-mainthread-cartographer-walk` | event-loop protection | `lint-allow-carto-heavy:` marker |
| 13 | `lint-no-wholefile-sync-read` | streamed-store reads | streaming read |
| 14 | `lint-journal-actuation-ban` | journal answers, live state actuates | live-state read |
| 15 | `lint-guard-manifest` | guard-inventory ratchet | classified in `NOT_A_GUARD` |
| 16 | `lint-store-retention-declared` | retention ratchet | `retention` block present |
| 17 | `lint-state-registry` | every store declared | registry entry added |
| 18 | `lint-cas-emit-placement` | placement history has no holes | paired `emitPlacement` |
| 19 | `lint-no-unreachable-messaging-gate` | un-enablable default-off gate | `lint-allow-messaging-gate:` marker |

**DENOMINATOR CORRECTED (09:15Z): the population is 29 ENFORCING + 1 warning-only, not 30 guards.**
`lint-degradation-emit-sites` is a deliberate detector — *"warning-only — exit 0 always (per spec
A33/A50)"* — so rung 3 does not apply to it. **Verified: 19 of 29 enforcing. A-confirmed/B-pending: 1 (`lint-emit-without-admit`). Untested: 10.**

## ⭐ SEVEN self-inflicted false negatives — ZERO genuine guard failures

**Every "the guard didn't catch it" result tonight was my test — SEVEN for seven.** The recurring causes:

1. **Full-repo scan mode misses untracked files** — pass the path explicitly. *(Hit 3×, after I had
   already documented it once.)*
2. **PATH-ALLOWLIST lints enforce on an enumerated file set** — inject into a listed file and revert.
3. **Wrong violation shape from guessing** — e.g. raw `execFileSync('claude')` against a lint that guards
   *provider-class construction*. *(A documented error, repeated hours later.)*
4. **Invented API in the B case** — `InFlightSyncOpMarker.around(...)` instead of `withSyncOp`; the real
   name was in the header I had already read.
5. **Edit never landed** — a bad anchor made a `sed`-style edit a no-op; looked like the guard rejecting
   valid input. **Assert the edit applied before trusting the result.**
6. **Wrong field depth when reading a registry** — `retention.access`, not `access`.
7. **Wrong construct entirely** — injected `config.messaging?.x?.enabled ?? false` against a lint whose
   pattern is a config **`.get('messaging.x', false)`** call. Different language construct; nothing could
   have matched.

> **The prior is now strong enough to state as a rule: a lint that appears broken is mis-invoked until
> its invocation has been read from source.**

## ⭐ The ratchet/gap pairing

`lint-guard-manifest` guarantees every guard-shaped component is **classified with a reason ≥12 chars**.
It **cannot check whether the reason is true.** That is exactly how `CrashLoopPauser` — never
constructed — carries a plausible, well-formed, and false justification and passes CI.
**The guard against omission exists; the guard against a false justification does not.**


---

# COMPLETE POPULATION CLASSIFICATION (2026-08-04 09:19Z)

The 30 `scripts/lint-*.js` guards resolve into **three classes**, and the classification is now complete
(every member checked, not sampled):

| class | n | rung-3 applicability | status |
|---|---|---|---|
| **Always-enforcing** | **28** | applies | **20 verified two-sided** · 8 untested |
| **Config-gated (report-only until an operator flip)** | **1** | applies *conditionally* | `lint-no-unregistered-self-action` — **enforcement path VERIFIED functional** (flip → `ENFORCING`, exit 1 on 19 real violations; restored → exit 0) |
| **Warning-only by spec** | **1** | **does NOT apply** | `lint-degradation-emit-sites` — *"exit 0 always (per spec A33/A50)"*; a detector, not an authority |

**So the honest scoreboard is `20 verified of 28 always-enforcing`, plus 1 conditional guard whose flip
is proven to work, plus 1 detector to which the standard does not apply.**

⭐ **Three different verdicts that a single "19 of 30" would have flattened into one wrong number.** The
warning-only member would have counted as a failure; the config-gated one would have counted as
unmeasured when its mechanism is in fact proven.

**The dark-guard flip method** (verify a config-gated guard's enforcement path in an isolated checkout,
production untouched) found only ONE applicable member in this tier — but it generalises to the
**runtime** tier, where 11 guards sit `on-dry-run` and every one is currently recorded as `unmeasured`.
**`bob` (a live throwaway agent on the current build) is the place to apply it.** Bound: it proves the
mechanism, never *this* machine.
