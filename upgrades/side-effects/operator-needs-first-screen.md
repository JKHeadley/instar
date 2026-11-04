# Side-Effects Review — Anything that needs the operator is on the first screen, counted, and linked

**Version / slug:** `operator-needs-first-screen`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 2, because it adds a rule to the outbound gate. Spec converged in two rounds. New: `dashboard/console/needs-model.js`, `src/core/operatorSurfaceReferral.ts`, two test files. Changed: Home's `combineNeeds` and `headline`, `loadHome`, seven pages (lead marker, Costs card, Development approval button, Agents switch position, alarm action), page copy, the tone gate's rule tables and prompt, the outbound route's signals, and the CLAUDE.md template plus its migration.

## Decision-point inventory

- `B22_SURFACE_REFERRAL` — add — advisory tone-gate rule, LLM-judged, anchored by a signal.
- `combineNeeds` / `headline` — modify — display only, more rows counted; "Checking in" until sources answer.
- `getOnce(…, soft403)` — add — a 403 on a Home source does not sign the operator out.

---

## 1. Over-block

The rule can nudge a message that merely mentions a page. It only applies when the detector fires, the prompt lists carve-outs and favours false negatives, and a nudge can be overridden with a reason. The cost of a true nudge is one round trip. An agent with no browser overrides with a stated reason. Automated senders and sentinel redrives never see it: the signal is only raised for a sender that can react.

## 2. Under-block

A referral phrased outside the detector's words gets no signal, so no nudge. Rendering confirmation is a self-report, recorded as one; the gate cannot see a browser. The floor catches its vocabulary and the registered states; a new need phrased differently relies on the side-effects question. A console on another machine does not see `merging`, `approvals` or `secrets` for the machine that holds them, filed to feedback.

## 3. Level-of-abstraction fit

The list is one pure module beside the page models and reuses their builders. The gate rule feeds the existing authority rather than running beside it. The first version put a receipt store and browser tool next to the gate; review cut them as more machinery than the problem earned.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. The detector is a pure signal with no I/O and is deliberately not in `GateSignalDetectors`, whose hits count as leaks on the outage path; a test pins that. The tone gate is the one authority and the rule's disposition is advisory.

## 4b. Judgment-point check (Judgment Within Floors standard)

B22 is a judgment point within a floor: a detector anchors it and the LLM decides by meaning whether this is a real referral. No static heuristic decides anything.

## 5. Interactions

- B21 covers multi-step procedures and carves out a single link tap. B22 covers a referral missing its link or words. The two do not compete: a one-tap ask with link and words passes both.
- A nudge plus the existing pending-advisory correlation means a revised resend is credited automatically. Render confirmation specifically needs the complied flag.
- Home's new reads add load every 30 seconds: about ten small reads, with the four feedback reads every fourth tick and only where the merge watcher answers. Each source has one in-flight read.
- The refresh place-keeping from the previous PR covers Home's page repaints unchanged.
- `surfacedNeeds` keeps last good rows for two minutes when a read fails.
- Live count: Home's count on this agent rises because real needs now count. That is the intended effect and could feel like a jump on first look.

## 6. External surfaces

Operator-visible: the Home count and rows, page leads, wording. Agent-visible: one new nudge and a CLAUDE.md section. No route shape changes, no new stored state.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes, and now enforced: 18 of 18 browser runs show the action on the first screen with no scrolling.
2. **Zero raw internals as primary content?** Rows use page wording, with no identifiers. Secret rows carry the label only, never the drop token, pinned by a test.
3. **Destructive actions de-emphasized?** No destructive action added. The spending card links out, and the alarm card's action is constructive.
4. **Plain language + phone width?** Screenshots read at 390x844, no sideways scroll on any page in the run.

## 6c. Agent Proposes, Operator Approves

`dashboard/console/mandates.js` only gains a lead marker on its existing approvals block, and Home gains a row that links to it. (1) The operator still approves a pre-filled request and constructs nothing. (2) The authority text is unchanged, authored by the server from structured data. No approval flow, field or wording changed.

## 7. Multi-machine posture (Cross-Machine Coherence)

Mixed, stated source by source in the spec. `accounts` is proxied-on-read through `scope=pool`. `merging`, `approvals` and `secrets` are machine-local today, the same reach as their pages. The gate is stateless per message. One-voice and topic transfer are unaffected.

## 8. Rollback cost

Revert and release. No migration to undo beyond a CLAUDE.md paragraph, which is harmless if left.

## Conclusion

Clear to ship after the second pass. The registry wording ships separately on the operator's answer.

## Second-pass review (if required)

Concern raised, then resolved. Independent reviewer: a queued reply redriven by the delivery sentinel could be held by B22, and the recovery policy treats any 422 as final, so it would never deliver. Resolved: a send whose delivery id matches a real queue row gets no B22 signal, pinned by an integration test both ways (a made-up id buys nothing). Precision items also fixed: the quote check was quadratic on long text (now linear and bounded), apostrophes no longer count as quotes, a 200 with the wrong shape counts as failed rather than "nothing waiting", and the conditional feedback source no longer holds the headline at "Checking in". Clean on the reviewer's other checks: the complied flag reaches the signal before the authority runs, a failed source never reads as "All quiet", secret rows carry no token. Concur after these fixes.

## Evidence pointers

Real judge (Haiku tier via the Claude CLI), five sample messages: a bare referral and a link-and-words message without confirmation get the nudge, the same message with confirmation passes, a report of the agent's own work passes. "Check the page if you like" was nudged, a borderline call the agent can override. The rule's text is added only for a flagged message, so the benchmarked prompt template and its saved benchmark are unchanged, pinned by the existing mirror test. `tests/unit/console-needs-first-screen.test.ts`, `tests/unit/operator-surface-referral.test.ts`, `docs/specs/reports/operator-needs-first-screen-convergence.md`. Browser proof ran through a proxy that refused all writes; the stop latch was not touched, no enable or rollback route was called, and the dashboard PIN was never read or used.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — the agent-authored rule "Operator-Surface Quality rule 1" was enforced only by a written attestation. Not a prompt defect; the fix is enforcement added beside it.
- **`closure`** — `guard`: `tests/unit/console-needs-first-screen.test.ts`.
