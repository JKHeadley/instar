# External cross-model review — round 8 (codex-cli:gpt-5.5)

Spec: docs/specs/grok-build-framework-integration.md
Status: ok · Verdict: SERIOUS ISSUES · promptTruncated: True

Disposition (round-8 synthesis): all four findings are re-arguments of
DECIDED points or style notes — (1) drift warn-vs-fail-closed: DECIDED AND
CLOSED in §4.1 (round-8/9 text: the billing invariant rests on three
per-call layers, never the version pin; the conflicting-conditions probe is
the named CMT-1299 item); (2) budget-ledger races: decided — bounded
last-writer-wins loss accepted with durable half-cap precharge +
record-every-path, defense-in-depth over a 24-run/day dark reviewer;
(3) interactive opt-in residuals: Frontloaded Decision — the dual gate
exists precisely to make that a deliberate per-agent act with the residuals
named; (4) structure/archaeology: the §0 normative-vs-status convention
governs. No NEW design-class finding.

---

**Verdict: SERIOUS ISSUES**

1. **Billing invariant weakens on CLI drift (§3.1.1, §4.1).**  
   The spec says unseen credentials are controlled by the vendor `disable_api_key_auth` policy, but later chooses warn-only behavior on unknown Grok CLI versions. That is defensible for tool-deny drift, but not for billing fallback semantics. If a CLI update changes `GROK_DISABLE_API_KEY_AUTH` behavior, the adapter may still run while the keychain/config fallback path reopens.  
   **Resolution:** split the drift policy: warn-only for tool inventory, but fail closed for billing-policy verification unless a live conflicting-conditions probe passes for the installed CLI version.

2. **Budget ledger admits work with known undercount races (§8, Multi-machine posture).**  
   The spec explicitly accepts check-then-act before spawn-slot acquire and last-writer-wins loss of up to `N-1` increments. For a pool the spec repeatedly calls invisible, this makes the “24 runs / 5M tokens per UTC day” ceiling non-authoritative under concurrent reviewer runs, especially because `waitersMax` is operator-tunable.  
   **Resolution:** make budget admission a reservation: file lock, SQLite, or atomic append log before spawn; reconcile actual tokens afterward. Capacity sheds can release or avoid reservation only if no process was spawned.

3. **Interactive opt-in can bypass unresolved retention and budget risks (§4.2, §4.3, §7).**  
   The spec says retention probing is required before fleet-wide interactive graduation, but §4.3 allows a Grok-class agent to enable interactive sessions while retention is uncharacterized and “no per-session budget brake” exists. That is not just rollout flexibility; it creates a second production lane with materially weaker controls than the reviewer lane.  
   **Resolution:** either keep interactive sessions hard-disabled until retention and session budgeting land, or require an explicit separate “unsafe/experimental interactive” flag whose name encodes those residuals.

4. **The spec is overfit to reviewer-round history and hard to implement from first principles.**  
   Sections §4.1, §4.3, §8, §11, and §12 mix normative requirements, implementation status, review-round archaeology, and lessons learned. The requirements are present, but buried.  
   **Resolution:** move probe history and review-round narrative to an appendix; keep each section to “MUST / MUST NOT / failure behavior / tests.”

I did not rely on the omitted `docs/signal-vs-authority.md`; this review is based only on the inlined spec.
