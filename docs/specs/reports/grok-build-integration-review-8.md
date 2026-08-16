# External cross-model review — round 13 (codex-cli:gpt-5.5)

Spec: docs/specs/grok-build-framework-integration.md
Status: ok · Verdict: MINOR ISSUES (MINOR ISSUES, third consecutive)

Disposition:
1. **Phase A extraction — FOLDED.** An "Acceptance for THIS increment (Phase A)"
   section now states exactly what ships and, explicitly, what Phase A passing
   does NOT accept. The reviewer is right that listing session/pin/pool work in
   scope made the live deliverable look larger than it is.
2. **"Open questions: none" overstates — FOLDED, and it was a real overclaim.**
   The heading now reads "Open questions (builder-blocking)", and a new "Known
   unknowns and deferred proof" table names eight operational unknowns with the
   default each is held at and the carrier that owns it. The original claim was
   true of BUILDER decisions and false as a statement about the world.
3. **Append-only records instead of locked mutable JSON — DECLINED for this
   increment, and already the stated pre-growth requirement.** §8 says exactly
   this: the JSON ledger is a per-machine circuit breaker, and anything beyond
   the dark reviewer lane requires append-only records keyed on idempotent run
   ids (CMT-1319). Swapping the storage model in the same round that just closed
   its concurrency hole would replace a tested mechanism with an untested one on
   a money-adjacent surface; the pattern is recorded as the migration, not
   improvised now.
4. **Tool-deny enumeration — DECIDED** across three rounds (§4.1): the ONLY live
   lane carries every compensating bound, and fail-closed-on-unknown-version
   would break the family on every routine vendor self-update.
5. Terminology — the normative-contract section is the implementation map; the
   local vocabulary is the repo's vocabulary.

---

**Verdict: MINOR ISSUES**

1. **Release contract is hard to extract (§ Current normative contract, §1, §4.3, §7).**  
   Source says Phase A is only the one-shot reviewer adapter, while Phase B is the actual “Grok-primary agent” goal and remains closed/threaded. The spec repeatedly lists session launch, pins, pool enrolment, and framework threading as in scope, which makes the live deliverable look larger than it is.  
   **Resolution:** split this into a short Phase A normative spec plus a separate Phase B design, or add a front-page “Acceptance for this increment” table that excludes every closed lane.

2. **“Open questions: none” overstates closure (§0, §6.1, §8, §14, Multi-machine posture).**  
   Source explicitly leaves billing sink unknown, quota unreadable, retention unprobed, enrolment incomplete, shared-lane prompt transport deferred, and cross-machine burn rollup deferred. These may be conservatively defaulted, but they are still operational unknowns.  
   **Resolution:** rename to “No undecided builder questions” and keep a separate “Known unknowns / deferred proof” table tied to CMT-1317/CMT-1319.

3. **The design reinvents a spend/event ledger where an existing pattern would be cleaner (§8).**  
   Source says the JSON ledger is only a per-machine circuit breaker, now with advisory lockfiles and stale-lock reclaim, and later admits append-only run records with idempotent run ids are needed before growth. That is a solved pattern: SQLite WAL, append-only JSONL with atomic rename, or a small local event log would be simpler than evolving locked mutable JSON.  
   **Resolution:** use append-only records now, even if scoped per-machine, so Phase A and future cross-machine rollup share the same accounting model.

4. **Tool-deny safety depends on enumerating vendor tools (§4.1).**  
   Source says unknown Grok versions only warn, and new vendor tools widen surface until re-pinned. Measured mitigation is scratch cwd, no shell, no web search, prompt cap, and budget cap; hypothesis is that residual is bounded. The likely failure is a CLI update adding a non-web tool or broader filesystem capability not covered by the deny list.  
   **Resolution:** prefer a deny-all/permission-mode control if the CLI has one; otherwise make unknown tool inventory fail closed for the reviewer lane, or add a live probe that asserts a deliberately disallowed tool cannot execute.

5. **Terminology is locally dense (§0.6 and throughout).**  
   Terms like “reviewer door,” “carrier,” “lane,” “dark,” and “stall matrix” are defined, but the spec still assumes Instar-internal review culture.  
   **Resolution:** add a compact architecture diagram or lifecycle table: config gate → detect → spawn → parse → ledger → degrade.
