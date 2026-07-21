# Independent security/authority review — Autonomous Throughput Floor

Date: 2026-07-20

Scope reviewed: PULL/AUDIT-ONLY runtime, production wiring, state sidecar, authenticated route, dashboard,
configuration/migration, tests, convergence report, and side-effects review.

## Review questions and verdicts

- **Can this feature contact a user or peer?** No. The runtime dependency interface has no notify,
  attention, relay, dispatch, restart, or remediation callback. The prior governor/controller entries
  were removed and a lifecycle ratchet checks their absence.
- **Can untrusted run prose expand authority or scope?** No. Runtime consumes only the active registry's
  topic/start identity and move markers. Repository scope is the configured project root's GitHub origin;
  no run-authored ref, path, URL, command, or message text enters argv.
- **Can shell injection occur?** No shell is invoked. Git and GitHub reads use fixed executable names and
  argv arrays. Owner/repository components are accepted only from a parsed GitHub origin and remain one
  argv value.
- **Can reads amplify indefinitely?** No. One tick may run at a time; PR lists are capped at 32 each;
  per-PR reads run in batches of four under one ten-second wall budget. Failures back off 15m/30m/60m
  and then open a restart-persisted six-hour breaker.
- **Can a corrupt/replayed state file fabricate a flatline?** No. Missing state establishes a fresh
  baseline. Symlink, oversized, malformed, wrong-version, identity-mismatched, future-dated, or invalid
  bounded state becomes `unknown`. Writes are 0600 temp → fsync → rename.
- **Can incomplete history fabricate silence?** No. A 100-row page must reach run start or the prior cursor;
  otherwise posture is `unknown`. Only `fromUser:false` updates the manager-outbound clock.
- **Can force-pushes or empty commits fabricate output?** No. A head change counts only when GitHub compare
  reports descendant/identical ancestry and the head tree SHA changed. New merge identities count directly.
- **Does the dashboard introduce action?** No. It performs an authenticated GET, creates text nodes, and
  has no control, POST, or mutation handler in the throughput section.
- **Does multi-machine ambiguity violate one-voice?** No voice exists. Runs are nevertheless ineligible
  unless exactly one machine is registered and no move marker is present.

## Findings corrected during review

1. Corrupt state was initially indistinguishable from a missing file and could silently mint a baseline.
   Corrected with an explicit corrupt sentinel and regression test.
2. The first production sweep used sequential synchronous `gh` calls without one shared deadline.
   Corrected to asynchronous fixed-argv calls, concurrency-four batches, and a shared ten-second budget.
3. Move posture was initially hard-coded false. Corrected to consume canonical autonomous run markers.
4. The monitor timer was not stopped with the server. Corrected in `AgentServer.stop()`.

## Final verdict

No unresolved security or authority finding. The code is structurally PULL/AUDIT-only. Proactive attention
remains a named follow-on requiring a separately converged SelfHealGate; no dormant seam exists here.
