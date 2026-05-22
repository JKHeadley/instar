---
title: ORG-INTENT Session-Start Injection — Phase 2
status: approved
approved: true
approver: justin
approved-at: "2026-05-22T04:55:00Z"
approval-context: "Pre-authorized as Phase 2 of the four-phase org-intent runtime project. Justin's seed message (2026-05-21 15:50 PDT, topic 11378) requested recommendations; Justin approved the full four-phase scope (2026-05-21 21:54 PDT) with explicit \"Yes! Please proceed in an autonomous session.\""
review-convergence: "2026-05-22T06:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T06:00:00Z"
review-mode: "single-author, pre-authorized scope"
lessons-checked:
  - "feedback_signal_vs_authority — session-start injection is SIGNAL only (informs the agent before drafting). Authority remains with the gate (Phase 1)."
  - "feedback_side_effects_review — full review at upgrades/side-effects/org-intent-session-start-injection.md."
  - "feedback_release_notes_in_same_pr — NEXT.md filled in this same PR."
  - "feedback_eli16_required_for_specs — companion at ORG-INTENT-SESSION-START-INJECTION-SPEC.eli16.md."
  - "feedback_no_pr_fragmentation — Phase 2 ships as ONE PR; Phases 3-4 queue behind merge."
  - "feedback_spec_converge_pre_auth_circular — Justin pre-authorized the full four-phase scope; /spec-converge would be circular."
created: 2026-05-22
owner: echo
companion-eli16: ORG-INTENT-SESSION-START-INJECTION-SPEC.eli16.md
eli16-overview: ORG-INTENT-SESSION-START-INJECTION-SPEC.eli16.md
phase-of: ORG-INTENT-RUNTIME-GATE-SPEC.md
---

# ORG-INTENT Session-Start Injection — Phase 2 Spec

> Inject parsed `ORG-INTENT.md` at session boot so the agent reasons with organizational intent from message one, not only when the Coherence Gate blocks them after the fact.

**Status**: Implementation Complete (Phase 2)
**Companion**: `ORG-INTENT-SESSION-START-INJECTION-SPEC.eli16.md`
**Author**: Echo (autonomous build, supervised by Justin)
**Origin**: Phase 2 of the four-phase ORG-INTENT runtime project. Phase 1 (`ORG-INTENT-RUNTIME-GATE-SPEC.md`) wired the gate; this phase wires the agent's own working context.

---

## Background

Phase 1 shipped `OrgIntentManager.parse()` integration into the Coherence Gate. The structured three-rule contract (constraints mandatory, goals defaults, values shape, tradeoff hierarchy resolves ties) now drives the value-alignment reviewer at outbound-message review time. But the gate is reactive — it blocks messages after the agent has drafted them. The agent itself does not know about the contract while drafting.

This phase closes that loop. By the time the agent composes a response, it has already seen the organizational intent in its session-start context. Most constraint violations should be prevented at the drafting stage, with the gate as the last-resort enforcement.

## Goal

Make `ORG-INTENT.md` part of the agent's working context from the first message of every session, the same way identity (`AGENT.md`), topic context, integrated-being state, and soul are already injected.

Non-goals (deferred to later phases):
- Phase 3: Standalone tradeoff helper consulted at decision points outside the reviewer.
- Phase 4: Periodic drift detection job.

## Design

### HTTP route

New endpoint `GET /intent/org/session-context`:

```
Request:  GET /intent/org/session-context
Auth:     Bearer <authToken>
Response: 200 OK
          { "present": true,
            "block":   "=== ORGANIZATIONAL INTENT === ...",
            "name":    "Acme Co",
            "counts":  { "constraints": N, "goals": N, "values": N, "tradeoffHierarchy": N } }
          OR
          200 OK
          { "present": false }
```

When `ORG-INTENT.md` is absent, template-only (HTML-comments only), or unparseable, the route returns `{ present: false }` and the session-start hook injects nothing — same shape as the Phase 1 fall-through.

### Formatter

`formatOrgIntentForSessionStart()` exported from `src/core/OrgIntentManager.ts`. Deterministic, single-newline-joined text. Constraints first (most load-bearing), then goals, values, and tradeoff hierarchy. Empty buckets are omitted entirely.

The format mirrors the existing session-start block style (`=== SECTION_NAME ===` ... `=== END SECTION_NAME ===`) so agents recognize the structure visually and the hook can inject it inline without further formatting.

### Session-start hook update

`PostUpdateMigrator.getSessionStartHook()` gains a new block that fetches `/intent/org/session-context` and prints the `block` field when `present: true`. Fail-open: route unreachable → silent skip. The Coherence Gate from Phase 1 still enforces the contract at message-review time, so missing the session-start injection never compromises constraint enforcement.

### Surface changes

| File | Change |
|---|---|
| `src/core/OrgIntentManager.ts` | Exported `formatOrgIntentForSessionStart()` function |
| `src/server/routes.ts` | New `GET /intent/org/session-context` route |
| `src/core/PostUpdateMigrator.ts` | `getSessionStartHook()` inline string adds ORG-INTENT fetch; `migrateClaudeMd()` updates ORG-INTENT subsection to mention Phase 2 |
| `src/scaffold/templates.ts` | CLAUDE.md ORG-INTENT subsection updated for new agents |
| Spec + ELI16 + side-effects | This file + companion + `upgrades/side-effects/org-intent-session-start-injection.md` |
| NEXT.md | Filled |

## Testing

All three tiers per Testing Integrity Standard.

### Tier 1 — Unit

`tests/unit/OrgIntentManager-session-start-format.test.ts` (new file):
- All four bucket sections render in expected order with preamble.
- Empty buckets are omitted entirely.
- Minimal intent (name only) renders preamble + framing only.
- Tradeoff hierarchy entries are numbered starting at 1.
- Two-space indentation for bullets.
- Output is deterministic.

`tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts`:
- Extended with two new tests: Phase-1-only subsection is upgraded to mention Phase 2; idempotent on Phase-2-upgraded CLAUDE.md.
- Existing Phase 1 tests adjusted to match the new subsection wording.

### Tier 2 — Integration

`tests/integration/org-intent-routes.test.ts`:
- Extended with four new tests for `GET /intent/org/session-context`: absent file, template-only file, populated file, partial-buckets file.

### Tier 3 — E2E lifecycle

`tests/e2e/org-intent-session-context-lifecycle.test.ts` (new file):
- Phase 1: `/intent/org/session-context` returns 200, not 503 — the "feature is alive" check, mirroring production wiring through `AgentServer` and `createRoutes`.
- Phase 2: Populated ORG-INTENT.md → all four bucket sections appear in the block.
- Phase 3: Absent / template-only → `{ present: false }`.

## Side effects

See `upgrades/side-effects/org-intent-session-start-injection.md`.

Summary: agents with an `ORG-INTENT.md` will see additional context at the start of every session (one new `=== ORGANIZATIONAL INTENT ===` block). Token cost is bounded by the file's own size (the parser only loads what's in the file). For agents without an `ORG-INTENT.md`, no change.

## Migration

- Existing agents: `PostUpdateMigrator.migrateClaudeMd()` upgrades the Phase 1 ORG-INTENT subsection to mention Phase 2 session-start injection. The session-start.sh hook itself is always-overwritten on every migration so the new fetch logic propagates automatically.
- Fresh agents: `generateClaudeMd()` includes the combined Phase 1+2 subsection.
- Idempotent: re-running migration is safe.

## Open follow-ups (Phase 3+, NOT this PR)

- Phase 3: `POST /intent/tradeoff-resolve` standalone helper.
- Phase 4: periodic drift detection job sampling recent outbound actions vs intent.
- Cache invalidation on `ORG-INTENT.md` mutation (currently the route reads from disk on every call — no cache, so edits propagate immediately at the cost of a tiny per-request fs.read).
- Per-channel constraint scoping.
