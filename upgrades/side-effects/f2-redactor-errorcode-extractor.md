# Side-Effects Review — F-2: Redactor + ErrorCodeExtractor

**Version / slug:** `f2-redactor-errorcode-extractor`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds two new foundation modules for the Self-Healing Remediator v2 (per spec §A1 Foundation manifest, F-2):

- `src/monitoring/Redactor.ts` — centralized redaction pipeline that strips secrets, identifiers, and absolute paths from text before it crosses any persistence, alert, or LLM-prompt boundary. Default rules cover home-dir paths, bearer/Telegram tokens, emails, UUIDs, long hex, IPv4/IPv6, and ≥6-digit numeric IDs. Composable via `extraRules`.
- `src/monitoring/ErrorCodeExtractor.ts` — extracts a canonical `errorCode` from one of four structured sources and stamps a `provenance` tag (`native-binding | probe-id | subsystem-explicit | free-text`). Implements §A6: the runbook registry validator can call `isAllowedForRunbookMatch` to refuse matchers that would consume free-text-provenance events.

Tests: `tests/unit/Redactor.test.ts` (25 cases) + `tests/unit/ErrorCodeExtractor.test.ts` (21 cases). No consumer code yet — F-3 (DegradationReporter migration) and W-* runbook wrappers wire these up.

Files touched:
- `src/monitoring/Redactor.ts` (new)
- `src/monitoring/ErrorCodeExtractor.ts` (new)
- `tests/unit/Redactor.test.ts` (new)
- `tests/unit/ErrorCodeExtractor.test.ts` (new)
- `upgrades/NEXT.md` (entry append)

## Decision-point inventory

- `ErrorCodeExtractor.isAllowedForRunbookMatch` — **add** — gating predicate the registry-load-time validator (built in a later PR) calls to refuse matchers against free-text-provenance events. The predicate itself is pure and side-effect-free.
- `Redactor.redact` / `Redactor.redactFields` — **add** — content transformation, no block/allow surface. Used by callers to sanitize before crossing trust boundaries.
- `ErrorCodeExtractor.extract` priority ladder — **add** — chooses which input source becomes the `errorCode` for a NormalizedDegradationEvent. Unverified probe emissions are silently demoted (signal source is untrusted) rather than producing a probe-id provenance.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- `Redactor.redact` may over-redact in two cases: (a) a legitimate ≥6-digit number (e.g. an HTTP status code referenced as a literal `200000`) collapses to `<NUM>` — acceptable because run-of-the-mill error text rarely contains literal big numbers, and false-positive redaction is preferable to leaking a real ID; (b) a real path on disk that happens to look like `/Users/<word>` always redacts, even when no user data is in it. Both are intentional: the redactor is the brittle low-level signal, not the smart authority — false positives are safe, false negatives are not.
- `ErrorCodeExtractor.extract` does not "reject" any input — it always returns a result. The `isAllowedForRunbookMatch` predicate rejects free-text provenance, which is the entire point of §A6. No legitimate runbook should match on free-text by design (matchers must consume structured sources).

---

## 2. Under-block

**What failure modes does this still miss?**

- `Redactor` cannot redact what it doesn't pattern-match. Novel secret shapes (a new vendor's API-key format, an unusual UUID variant, base64-only tokens without a `Bearer` prefix) will pass through. Mitigation: `extraRules` lets callers extend per-surface; the F-3 DegradationReporter migration will set a baseline set of patterns; SystemReviewer corpus tests (later phases) catch drift.
- `ErrorCodeExtractor` will return `provenance: 'free-text'` + `UNKNOWN_ERROR` for any novel failure shape. That's the intended steady state — A26 NovelFailureReviewer clusters these and proposes new runbooks via the /instar-dev path. The under-block here is not a bug; it's the trigger for SystemReviewer.
- Probe-id provenance is gated on a caller-supplied `verifyProbeSignature` function. If a caller forgets to pass one, the probe emission silently demotes to lower-priority sources. This is fail-closed (an attacker can't shape errorCode by spoofing the probe path) but a caller could mistakenly believe probe emissions are honored when they aren't. F-3 / W-* PRs that wire this up will own the verifier.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

`Redactor` is a **low-level detector** — it produces sanitized text plus a count summary. It does NOT decide whether to alert, persist, or drop an event. That authority belongs to DegradationReporter (F-3) and downstream consumers. Correct level.

`ErrorCodeExtractor` is also a **low-level extractor** — pure function over a structured input. It does NOT decide what to do with the extracted code. The `isAllowedForRunbookMatch` predicate is a signal the runbook registry validator (a smart authority, built in a later PR) calls — the extractor itself has no block/allow surface on the event path. Correct level.

Neither module re-implements anything that exists today: there is no shared redactor in src/ to replace (the spec §A1 explicitly notes "v1 was never built"), and ErrorCodeExtractor is genuinely new.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.

`Redactor` produces sanitized strings + a redaction summary — pure transformation, no block/allow. Callers (DegradationReporter F-3, runbook auditors, SystemReviewer) own any decisions.

`ErrorCodeExtractor.extract` is pure extraction. `isAllowedForRunbookMatch` is a predicate the runbook **registry validator** (a smart authority with full context — sees the entire matcher definition, the event corpus, and the runbook lifecycle state) calls. The extractor publishes the signal (the provenance tag); the validator decides whether to load the runbook. This is exactly the signal-vs-authority split §A6 requires.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** none today — these modules have no callers in this PR. F-3 will wire `DegradationReporter` to use them; until then they're dead code, by spec design (foundation must land before any wrapper).
- **Double-fire:** none — pure functions, no side effects.
- **Races:** none — no shared mutable state. Each `Redactor` instance owns its rule list; `ErrorCodeExtractor` is static.
- **Feedback loops:** none — these modules don't write to disk, network, or any other surface that could feed back.
- **Adjacent cleanup:** the existing `DegradationReporter` (untouched in this PR per F-3 scope boundary) continues to produce its legacy `DegradationEvent` shape. F-3 will introduce the back-compat shim per §A33; until then there's zero behavioral change for any current degradation emit-site.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** no — no shared state.
- **Other users of the install base:** no — modules are not wired into any runtime path in this PR. Behavior on `main` after merge is unchanged for end users.
- **External systems:** no.
- **Persistent state:** no — these modules don't read or write any file. (Future callers in F-3 will, but not these modules themselves.)
- **Timing or runtime conditions:** no — pure synchronous functions, no clocks.
- **API surface changes:** two new exported modules under `src/monitoring/`. They appear in the public surface of the package, but with no consumers in this PR, no migration risk.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- Pure code addition, no consumers. Revert = delete files + revert the NEXT.md entry. No persistent state, no user-visible regression during rollback window. No agent state repair needed.
- If a default redaction rule produces a false positive that surprises a downstream caller in F-3+, the fix is to refine the regex in `Redactor.ts` and ship a patch. The redactor's API (the `RedactionRule` type + the `redact`/`redactFields` shape) is stable and the cost of a rule tweak is one PR.
- If a free-text pattern in `ErrorCodeExtractor` produces a misclassification, downstream consumers see `provenance: 'free-text'` and the runbook registry refuses any matcher that would have fired on it. The misclassification surfaces as a clustering signal in SystemReviewer (a later phase), not as a misfired runbook. Fail-safe by design.

---

## Conclusion

Pure-foundation PR with two new modules and 46 passing unit tests. No consumers wired in this PR (per spec §A1 ordering: F-2 must land before F-3, and F-3 owns the wiring). Signal-vs-authority compliance is straightforward — both modules are detectors/extractors with no blocking surface; the §A6 provenance gate is a signal consumed by a smart authority (the runbook registry validator) that will be built in a later PR.

Clear to ship.

---

## Second-pass review (if required)

Not required — this PR has no block/allow surface on outbound/inbound messaging, no session lifecycle touch, no context-exhaustion handling, no coherence/idempotency/trust gates, and is not a sentinel/guard/gate/watchdog.

---

## Evidence pointers

- `npx vitest run tests/unit/Redactor.test.ts tests/unit/ErrorCodeExtractor.test.ts` → 46 passed, 0 failed (run during build).
- `npx tsc --noEmit` → clean.
- Spec section references: `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A1 (foundation manifest F-2 ordering), §A6 (errorCode provenance), §A26 (Redactor consumer in NovelFailureReviewer), §A33 (DegradationReporter migration — out of scope, for F-3).
