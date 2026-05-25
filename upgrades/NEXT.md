# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new capability, backward compatible -->

## What Changed

Threadline collaboration is now **visible to the operator** instead of happening
in an invisible side channel (CMT-509). Driven by a real incident: an agent-to-
agent collaboration ran entirely in background worker sessions and never surfaced
to the operator, AND the "report back" commitment resolved with the operator never
informed.

**The fixes (a quiet MVP — convergence scoped it down from "surface everything"
so it doesn't violate the near-silent-notifications standard):**

1. **Report-back commitments wait for the user.** A `threadline-reply` commitment
   no longer resolves on delivery-mode alone — it resolves only when the reply was
   actually surfaced to the user (live-inject into the topic session, or a
   resume-pending whose Telegram surface confirmed). An un-surfaced reply leaves
   the commitment OPEN (beacon keeps heartbeating; 7-day TTL backstop).
2. **Parentless conversations surface to a dedicated Threadline topic.** When a
   peer reaches out cold (no parent topic), a single warranted first contact posts
   to ONE dedicated "Threadline" topic — created on demand + reused, kept separate
   from the generic attention list, never per-thread. One quiet post per
   conversation (deduped), gated by the warrants-a-reply check so a multi-turn
   exchange doesn't flood the operator.
3. Topic-bound conversations continue to surface in their parent topic
   (TopicLinkageHandler), at most one user-facing post per reply.

## What to Tell Your User

When another agent collaborates with me, you'll now see it: cold outreach shows up
as one quiet heads-up in a dedicated Threadline topic, and a collaboration tied to
one of your conversations surfaces right there. And "I'll report back" now actually
waits until you've been told — it won't quietly mark itself done. It stays
near-silent: only genuinely new, relevant content surfaces.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Parentless-conversation surfacing | Automatic; one dedicated "Threadline" topic, deduped, near-silent |
| Commitment resolves only after user-facing surface | Automatic; un-surfaced replies keep the commitment open |

## Migration Notes

Additive. New state file `.instar/threadline/collaboration-surface.json` (dedicated
topic id + dedupe). Behind `threadline.surfaceCollaboration` (default on). No
`~/.codex` or relay change.

## Evidence

- Spec: `docs/specs/THREADLINE-COLLABORATION-SURFACING-SPEC.md` (+ ELI16 +
  convergence report — scoped down to a low-noise MVP; §3 found to need no code
  change against the live behavior).
- Tests: `CollaborationSurfacer.test.ts` (9 — routing/dedupe/topic-reuse/JSON-strip/
  non-fatal), `TopicLinkageHandler.test.ts` (+1 regression: resume-pending with no
  surface keeps the commitment open), wiring-integrity
  `collaboration-surfacing-wiring.test.ts` (5 — constructed + invoked at both seams).
- Test-as-self on live `instar-codey` before merge (cold peer note → one operator
  update, no spam, commitment resolves only after).

## Rollback

Behind `threadline.surfaceCollaboration` (flag off = today's behavior). The
commitment-resolution change is a guard on an existing call; revert removes it. No
state migration.
