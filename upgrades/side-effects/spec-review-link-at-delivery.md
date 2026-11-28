# Side-Effects Review — The spec-review link rule moves to the owner delivery point

**Version / slug:** `spec-review-link-at-delivery`
**Date:** `2026-11-28`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (outbound messaging block/allow), recorded below`

## Summary of the change

The `SPEC_REVIEW_LINK` check (check 8) is deleted from `src/templates/scripts/convergence-check.sh` on every agent. The hook could not tell who a message is for, so it blocked review verdicts between agent sessions on the local bus. Its job moves to the server's outbound check, which runs only on routes that reach a person.

- **New outbound rule `B27_SPEC_REVIEW_UNLINKED`** (`src/core/MessagingToneGate.ts`). It is advisory, judged by meaning, and rendered on every eligible review while `toneGate.specReviewLinks.enabled` is on.
- **Eligibility** is an explicit `specReviewEligible` opt-in set only by the session-reply routes in `src/server/routes.ts`: Telegram reply, Slack, app, WhatsApp, iMessage validate, Telegram browser session sends, and owner email.
- **Detector** (`src/core/specReviewHandoff.ts`): check 8's text tests become hints. A local lookup reports whether a document or view id exists here.
- **Override chain** (routes.ts): an acknowledgment answering a review that rendered B27, or any text already in a chain, never sends on its own. The text is re-reviewed with every acknowledged rule left out of the prompt's accepted citations. It sends only when that review passes or reaches the gate's documented fallback. Grades are recorded when the re-review passes, before delivery (section 5).
- **Per-call accepted citations** (gate): B27 where it was not rendered, or a rule a chain left out, is a stray citation. It takes the invalid-citation path (one retry, then that path's outcome) and is counted in evidence.
- **Owner email** (`src/server/emailRoutes.ts` + wiring) runs `checkOutboundMessage` behind `toneGate.ownerEmailCheck.enabled`:
  - metadata is limited to the four tone keys;
  - a localhost link gets an email-specific refusal with no escape;
  - the topic's chat is never used for its duplicate check;
  - revision memory is keyed by channel and topic;
  - the route gets the outbound messaging timeout (`src/server/middleware.ts`).
- **Evidence:** rows under `toneGate.specReviewLinks` in the feature-evidence log. Per-call body capture applies only on enrolled agents (`toneGate.specReviewLinks.captureBodies`), up to a separate 20,000-character ceiling.
- **Supporting changes:** two dev-gated switches, two ladder entries, one awareness entry.

**Tier:** 2 (it narrows a blocking hook check and puts a new route under the outbound gate). **Size:** about 21 files: about 570 source lines and about 620 test lines. **Effort:** 6 spec review rounds (at the cap), one second-pass review round, and one commit attempt so far.

## Decision-point inventory

- `SPEC_REVIEW_LINK` in the hook — **remove** — a keyword veto with no recipient knowledge (Chief of Staff's decision, message `4a516a3b`).
- `B27_SPEC_REVIEW_UNLINKED` — **add** — an advisory judgment at the owner delivery point.
- Eligibility opt-in, detector facts — **add** — fixed by route, and hints only.
- Override chain — **add** — structural. It keeps every other rule reachable behind an advisory acknowledgment on B27-rendered or chained text.
- Per-call accepted citations — **modify** — a stray citation was previously valid globally.
- Owner email outbound check — **add** — the existing gate on a route that skipped it, behind its own switch.

---

## 1. Over-block

- **B27 nudges** are overridable with a reason. The worst case is a delay of one resend. With the override chain, an override costs one extra review, and up to two more under the gate's retries.
- **Stray citations** take the invalid-citation path. A model re-citing a rule that an override chain already acknowledged used to be accepted as valid. Now it gets one retry, then the invalid-citation outcome: a hold, or delivery on the operator's own channel under `tiered`. That can hold a chained override until a valid verdict arrives. A B27 citation where B27 was not shown takes the same path, which is the path any unknown rule took before this change. Both are counted (`stray-citation`) so they are visible.
- **Revised text opens a fresh chain.** The chain is keyed by the text's hash, so revising chained text means B27 is shown again and may need a new acknowledgment. This is by design: a different text is a different decision.
- **Owner email** on development agents now meets every outbound rule. There, the advisory migration makes the judgment rules nudges. Unknown metadata keys are now a 400, but only while the switch is on.

## 2. Under-block

- **The fleet** has no spec-link reminder until B27's fleet-on release. This is the trade-off the Chief of Staff chose: spec-converge is for the instar-developing agent only.
- **Paths outside the server:** direct-to-provider sends and iMessage after validation never reach the server (CMT-073).
- **Unchecked links:** the gate does not fetch links, so a link that looks right but does not open is not caught. The suggestion points to the publishing script, which checks its own link.
- **Provider failure:** B27 is not judged on sends where the gate degrades or fails open. These are recorded as `unjudged-pass`.

## 3. Level-of-abstraction fit

This is the right layer: the route knows the recipient, and the hook never did. The rule feeds the existing tone gate (one authority), rather than adding a parallel check. The detector is a signal into it.

## 4. Signal vs authority compliance

- [x] No: this change removes a brittle blocking check, and adds a signal (the detector) feeding the existing LLM authority.

B27's authority is the tone gate's judgment, advisory and overridable with a recorded reason. The override chain is structural, and it only ever keeps other rules reachable. It never blocks on its own.

## 4b. Judgment-point check (Judgment Within Floors standard)

B27 is a judgment-candidate:
- **Arbiter:** the tone gate.
- **Floor:** an advisory nudge.
- **Default:** under-fire.
- **Fallback ladder:** detector throw, then provider failure, then switch off or not eligible.

Eligibility, facts and the chain are invariants, each with an enumerable-domain basis (spec, Decision points touched).

## 5. Interactions

- **B25:** stays a hold. The chain keeps it reachable behind a B27 override, and tests cover both orders.
- **B24:** may nudge a `/view/` link toward a document. B27 accepts either, so they never conflict.
- **B26 and the sibling confirm:** independent. `-b26` and `-b27` suffix the prompt id in that order.
- **Revision credit:** now keyed by channel, so an email nudge and a chat reply never credit each other.
- **Re-entry:** a chained acknowledgment re-enters `evaluateOutbound` once, with no acknowledgment. It cannot recurse further, because only an acknowledged resend opens a chain step. The re-entry gets a fresh review budget, not the remaining one, and redoes fact gathering. The worst case is about 2 × (20 s review + 20 s sibling confirm) plus the 6 s organization check, roughly 86 s, which is under the 120 s route timeout.
- **When grades are recorded:** chain grades are recorded when the re-review passes, inside `evaluateOutbound`, before delivery. A later transport failure still leaves them recorded. The `override-chain` decision-log line written at the acknowledgment marks a pending chain step, not an executed override.
- **Duplicate check:** skipped for `email` only.
- **Localhost guard:** an email-specific message. Other channels are byte-identical.

## 6. External surfaces

- **Other agents:** their bus sends are never blocked for a missing link.
- **Owner email callers on development agents:** may now get `422 tone-gate-advisory`, `tone-gate-blocked` or `localhost-link-guard`. The awareness entry documents the resend shapes. With `toneGate.ownerEmailCheck` on, `checkOutboundMessage` also does three things on email:
  - runs the organization check, so `422 org-policy` is possible in block mode;
  - runs the observe-only self-violation, principal-coherence and raw-text observers on the topic;
  - writes an attribution send-side record under `email:<topicId>`.

  A live credential is refused by `evaluateOutbound`'s wall (`credential-exposure-guard`, `credentialGuardMessage`) before the email service's own guard sees it, so the refusal body has a different shape.
- **Timeout, even with the switch off:** `/email/send-to-owner` gets the 120 s outbound messaging timeout unconditionally (`src/server/middleware.ts`), instead of the 30 s default. Otherwise the route with the switch off is unchanged, and its metadata is not read.
- **Benchmark:** the tone-gate prompt id splits at this release on development agents (`-b27`). The benchmark compares within an id.
- **Evidence store:** body capture happens only where it is explicitly enrolled.

**Status surfaces:** none new. The ladder entries show in the existing maturation board.

## 6b. Operator-surface quality

Not applicable: no dashboard renderer, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

**unified:** code and config ship to every machine. Each message is judged on the machine where the session sends it. Owner email is judged before any forward to the lease holder, and the holder's forward path does not judge again. The chain and revision memory are in-process and per machine by design: a resend goes back to the same route on the same machine within ten minutes. Evidence rows use the existing per-machine log.

## 8. Rollback cost

- **Flags:** `toneGate.specReviewLinks.enabled: false` stops B27, and `toneGate.ownerEmailCheck.enabled: false` stops the email check. Both are read live.
- **Check 8:** restoring it needs a revert release, since it is deleted from the template.
- **State:** none to repair.

## Conclusion

The change removes a misfiring keyword veto and puts its intent where the recipient is known. It ships on development agents first, behind two switches, with evidence for graduation. Its narrowings at build are recorded in the spec and the convergence report:
- no document titles;
- an acknowledged-rules section instead of editing the hashed template;
- "approve" as handoff wording.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (claude-opus-5-5), read-only code audit of the full diff, 2026-11-28.
**Independent read of the artifact: concern, then resolved**

**Round 1 concern.** One blocking test bug: the chain test asserted that B27 never appeared from the second prompt on, but that prompt is the acknowledgment's own first review, which must show B27. Eight minor points.

**Resolutions:**
- **The test** now checks that prompt 1 shows B27 and that every prompt after it does not.
- **M2:** pass and other-rule evidence rows are written only when the review rendered B27.
- **M1, M3, M4, M5, M8:** stated above in sections 1, 5 and 6.
- **M7, skill text:** the bundled `skills/spec-converge/SKILL.md` backstop line is corrected. Installed copies need a hash-aware update step, tracked as CMT-075 (PR by 2026-12-04). The awareness entry is one file for both switches, and the spec now says so. The own-host list is the same as B24's: loopback plus the tunnel host.
- **M6, tests:** an existence-fact test (yes, no, unknown, view, outside) was added to the route integration file. These spec-listed tests are narrowed:
  - **The over-4,000-character email capture:** covered by the gate unit test of the 20,000 ceiling, `buildToneDecisionContext`. The route only passes `captureBody`.
  - **Recovery after the outbox row is terminal:** this reads the decision record, not the outbox. The unit capture test covers it, and the reader procedure lives in the graduation review, not in code.
  - **Revision credit across channels:** the key change is structural (channel plus topic). No direct test.

**Round 2 (2026-11-28 06:01 PT):** the reviewer traced the new existence-fact test to a pass, confirmed every fix, accepted the disclosed test narrowings, and flagged two wording slips, now corrected (the Summary's grading sentence, and section 1's stray-citation sentence).

**Verdict:** Concur with the review.

## Evidence pointers

- Spec: `docs/specs/spec-review-link-at-delivery.md` (converged 6/6, approved). Report: `docs/specs/reports/spec-review-link-at-delivery-convergence.md`.
- Unit runs on the M5 through the heavy-turn wrapper (all passed before the second-pass fixes; re-run after them, see the PR):
  - the new detector and gate files, and the hook file;
  - the rule-registry ratchets (B15, B18, B21, B23, B24, B26, judge-by-meaning, advisory migration, spec approval, surface referral);
  - the dev-gate wiring, awareness registry, maturation ladder, ladder coverage, outbound timeout and hook-related files.
- The integration files run on a helper machine (the M5 runs no integration tests by hand). The exact head and counts are recorded in the PR.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change moves and narrows an outbound check (code); it adds no self-triggered controller.
