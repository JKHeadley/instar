# Side-effects review — org-intent session-start injection (Phase 2)

Spec: `docs/specs/ORG-INTENT-SESSION-START-INJECTION-SPEC.md`
ELI16: `docs/specs/ORG-INTENT-SESSION-START-INJECTION-SPEC.eli16.md`
Phase: 2 of 4. Phase 1 (gate wiring) shipped as v1.2.23 (PR #315). Phase 3 (tradeoff helper) and Phase 4 (drift detection job) are queued.

## Surface map

| Change | File | Type |
|---|---|---|
| Exported `formatOrgIntentForSessionStart()` formatter | `src/core/OrgIntentManager.ts` | Additive function export |
| New `GET /intent/org/session-context` HTTP route | `src/server/routes.ts` | Additive route |
| Session-start hook fetches + injects parsed ORG-INTENT block | `src/core/PostUpdateMigrator.ts` (`getSessionStartHook`) | Behavior change to agent-installed hook script |
| CLAUDE.md ORG-INTENT subsection updated (mentions Phase 2) | `src/scaffold/templates.ts` + `PostUpdateMigrator.migrateClaudeMd()` | Doc + migration |
| Tier 1 unit tests (formatter + migration) | `tests/unit/OrgIntentManager-session-start-format.test.ts`, extended `PostUpdateMigrator-org-intent-runtime.test.ts` | Test addition |
| Tier 2 integration tests | Extended `tests/integration/org-intent-routes.test.ts` | Test addition |
| Tier 3 E2E test | `tests/e2e/org-intent-session-context-lifecycle.test.ts` | Test addition |

## Over-block analysis

**Could the injection push the agent's context over a token budget?**

The block size scales with the `ORG-INTENT.md` file size — the formatter doesn't add content; it just labels and structures what's already there. A typical authored `ORG-INTENT.md` is dozens of bullets across four sections — comfortably under 500 tokens. The cap is the source file itself; an organization with a 10-page ORG-INTENT.md will see 10 pages injected. That's a feature, not a bug — but operators should be aware that very large intent files consume context.

**Could the hook fail in a way that disrupts session start?**

No. The hook uses `curl -sf --max-time 4` and a wrapping `if [ -n "$ORG_INTENT_RESPONSE" ]; then ... fi`. Any failure path (route unreachable, 503, network timeout, malformed JSON) results in silent skip. The session continues normally. The Coherence Gate from Phase 1 still enforces the contract at outbound message time, so missing the session-start injection never compromises constraint enforcement.

**Could the new route be abused / DoS'd?**

The route reads `ORG-INTENT.md` from the agent's state dir on every request — bounded local disk read, no LLM call, no DB query. The auth middleware enforces Bearer-token gating. Rate at which an attacker could call it is also bounded by the same auth gate. No new abuse surface beyond `GET /intent/org` (which already existed).

## Under-block analysis

**What does the injection NOT catch?**

- A subtle constraint violation the agent doesn't recognize when drafting. The injection helps the agent *understand* the constraints; the gate is what actually *enforces* them. If the agent's reasoning misses a constraint applicability, the gate catches it.
- Constraint applicability scoping. A constraint like "never quote internal pricing externally" depends on knowing if the recipient is external. The injection surfaces the constraint; the agent must reason about applicability. Phase 3+ may add scoping metadata to constraints.
- Mid-session ORG-INTENT.md changes. The injection happens at session start. Edits during a session do not propagate until next session.

## Level-of-abstraction fit

The formatter lives in `src/core/OrgIntentManager.ts` alongside the parser — the right place for a pure rendering function. The HTTP route lives in `src/server/routes.ts` next to `GET /intent/org`. The hook update lives in `PostUpdateMigrator.getSessionStartHook()`, the canonical source for session-start hook content. No new abstractions introduced.

## Signal-vs-authority compliance

The session-start injection is **SIGNAL** — it informs the agent's reasoning but has no authority to refuse or modify outbound messages. The Coherence Gate (Phase 1) remains the **AUTHORITY**: constraint violations are blocked at outbound-message review time regardless of whether the agent saw the injection at session start.

This separation is intentional. A signal-only injection is robust to malformed `ORG-INTENT.md`, route failures, and hook timeouts — the worst case is "the agent doesn't see the contract this session," not "the agent ignores the contract." The authority layer (the gate) catches what the signal misses.

## Interactions with existing systems

| System | Interaction | Risk |
|---|---|---|
| Coherence Gate (Phase 1) | None — different layer, different lifecycle | None |
| `GET /intent/org` | Sibling route — same data, different formatting | None |
| Session-start hook (existing) | Adds one new fetch + inject block alongside identity, topic, integrated-being, soul, working-memory, etc. | Low — fail-open, bounded by curl --max-time 4 |
| Working memory injection | Independent — both contribute to session-start context | Token cost is additive but bounded |
| PostUpdateMigrator other migrations | New migration path operates on an isolated content region | Low — content-sniff guards |
| Existing `getSessionStartHook()` content | Added inline block; rest unchanged | Low — verified by template parity test pattern |

## Rollback cost

Low. Three options:

1. **Code revert**: `git revert <PR-merge-sha>` removes route + hook block + format function. Tests would need removal too.
2. **Soft revert via hook bypass**: edit installed `session-start.sh` to remove the curl/python3 block. The route remains but is just an unused HTTP endpoint.
3. **Soft revert via empty file**: replace `ORG-INTENT.md` with template-only content; the route returns `{ present: false }` and no injection happens. The Phase 1 gate also gracefully degrades on template-only.

No data migration to roll back. No file format changes. The Phase 1 wiring is unaffected by this change.

## Test coverage summary

| Tier | File | Tests | Status |
|---|---|---|---|
| 1 (unit) | `tests/unit/OrgIntentManager-session-start-format.test.ts` | 6 | ✓ passing |
| 1 (unit) | `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` (extended) | 7 (2 new for Phase 2) | ✓ passing |
| 2 (integration) | `tests/integration/org-intent-routes.test.ts` (extended) | 11 (4 new for Phase 2) | ✓ passing |
| 3 (E2E lifecycle) | `tests/e2e/org-intent-session-context-lifecycle.test.ts` | 3 | ✓ passing |

## Open follow-ups (deferred to later phases, NOT this PR)

- Phase 3: `POST /intent/tradeoff-resolve` standalone helper.
- Phase 4: periodic drift detection job sampling recent outbound actions vs intent.
- Mid-session ORG-INTENT.md change propagation (fs.watch or signal-based reinject).
- Per-channel constraint scoping (some constraints external-only, others universal).
- Cache layer in front of the route if call rate becomes notable (currently bounded by session-start frequency, which is ~1 per session).
