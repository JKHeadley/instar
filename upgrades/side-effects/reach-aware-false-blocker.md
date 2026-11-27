# Side-Effects Review — reach-aware false-blocker check

**Version / slug:** `reach-aware-false-blocker`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 6 files plus tests, about 300 lines. Effort: no spec rounds (Tier 1); the prompt-hash pin caught a first draft that put the new rule in the static prompt, so the rule moved into the signal-gated section, as B23 does.

Fixes Echo Bugs topic 10000002506. Twice in one hour an agent told its operator that a check needed them, when its own key and its browser's signed-in operator accounts already covered it. The outbound gate's B17 (false blocker) only saw the text, so "only your browser can see it" read as a genuine access limit.

- `src/core/operator-errand.ts` (new): a signal-only phrase detector for asks that hand the operator a look, check, open or send errand.
- `src/core/agent-reach.ts` (new): builds the reach record (browser-profile accounts with owner, plus a fixed list of what the agent's own key reads) and renders it as plain lines. It is sanitized, capped at 24 accounts, and never throws.
- `src/core/MessagingToneGate.ts`: new `operatorErrand` signal and `agentReach` context. When the signal is set, an AGENT REACH section carrying the B17 REACH sub-clause is rendered in its own random boundary. The static prompt template is byte-identical, so the benchmark hash pin holds.
- `src/server/routes.ts` (`evaluateOutbound`): for `reply` kind only, runs the detector. On a hit it builds the reach from the Playwright registry. Fail-open.
- `src/core/PlaywrightProfileRegistry.ts`: the session-start block gets a two-line "do it yourself, mark on-behalf sends" note. The default byte cap goes from 800 to 2400, because at 800 the Studio showed 3 of 12 profiles and hid the operator's Google and Slack.

## Decision-point inventory

- `MessagingToneGate` B17_FALSE_BLOCKER (modify): new sub-clause, fed new context, only when the errand signal fired.
- `evaluateOutbound` signal assembly (pass-through): adds one signal plus one context object.
- No other decision point is touched.

---

## 1. Over-block

The risk is a legitimate operator ask being blocked as a false blocker:
- "Can you look at the new screen on your phone and tell me if it feels right?" is a taste judgment. It is excluded by name and must pass.
- "Can you check your bank app for the charge?" is an account not in the reach list, so it must pass.
- "Can you send the 2FA code?" is a secret, excluded.
- "Can you message Sarah from your account?" is a real message to a third party in the operator's name, excluded.
- "Can you check the app on your phone shows the new badge?" / "did the push notification arrive?" — a check of how something renders, arrives or behaves on the operator's own device. The agent's key reads data, not the device. Excluded by name after second-pass review (the first draft's "anything the dashboard shows" wording would have walled these off).
- "Can you send the release note to the team?" — a send through the operator's account to others. Covered ONLY when a present standing-authorization grant covers it (that context is dev-gated and observe-only by default, so in practice: not covered, the ask passes). Narrowed after second-pass review: a registered operator profile is consent to look, not to speak as the operator.
- Remaining over-block shapes: (i) the reach list says an operator account is signed in but the login has since expired (login state is last-asserted). The agent is told to do it itself, tries, finds the login expired, and re-sends the ask with that outcome named, which B17's existing named-outcome carve-out passes. One wasted attempt. (ii) The broad phrases ("need you to", "can you send", "can you try") bring the reach section into many messages that are not errands, including approval asks. The section is context only; approval and decision asks are told to be judged by the existing carve-outs, and the under-fire bias applies.
- B17 is in the self-stop family that stays a wall (`ADVISORY_MIGRATION_EXEMPT_RULES`), so a wrong block cannot be acknowledged away. Mitigations: the decisive under-fire bias, the explicit must-pass list, and the existing named-outcome carve-out, which gives the agent an honest path (try, then name what happened).

## 2. Under-block

- An errand worded so it trips none of the phrases ("the list is only visible to you") gets no AGENT REACH section. The static B17 still applies, but blind to reach, as before. The phrase list is a pre-filter by design, so a miss only costs today's behaviour.
- Reach outside the Playwright registry is not listed: computer use on the desktop, other MCP tools, vault secrets. The static B17 already names computer use and MCP as the agent's own means.
- Agent-key reads are a fixed description, not computed per route. That is accurate for every instar agent (the dashboard and app are served by the agent's own server under that key), but it doesn't enumerate routes.
- Finals sent from paths other than `evaluateOutbound` (for example, direct adapter sends) are unchanged.

## 3. Level-of-abstraction fit

This is the right layer. The detector is a cheap signal. The reach is plain data. The decision stays with the existing LLM authority (B17), which has the conversation. No new gate or rule id was added. It builds on B17 (the task brief asked for that) and follows the existing patterns: `askWhenAuthorized` plus `standingAuthorization` for context-fed B17, and B23 for rule text rendered only when its signal is present.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

The phrase detector and the reach builder hold no authority. The full-context LLM gate decides, with an explicit under-fire bias.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The phrase list only decides whether the judge is shown extra context. The judgment itself stays with the LLM.

---

## 5. Interactions

- **Shadowing:** B16, B19 and the standing-authorization sub-clause are unchanged. Citation precedence (B15 > B16 > B17 > B18) is unchanged; the sub-clause tells the judge to cite B17_FALSE_BLOCKER.
- **Double-fire:** `parkedOnUser` and `operatorErrand` can both fire on "you'll need to…" style texts. They anchor different rules, and only one verdict is returned, as today.
- **Races:** the registry read is synchronous and read-only (`listProfiles` re-checks folders). A concurrent registry write is CAS-protected inside the registry.
- **Feedback loops:** none.
- **Cost:** the registry read and the extra section happen only for reply-kind messages that trip the detector.

## 6. External surfaces

- Agents across the install base: their B17 now sees reach on errand-shaped replies. Their session-start browser block is longer (≤2400 bytes, up from ≤800) and has two extra lines.
- No new routes, no persistent state, no change to the 422 response shape.
- Operator surface: none.

## 6b. Operator-surface quality

No operator surface. Not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN. Browser profiles and their cookies live on one machine's disk (the registry's own D6 posture), so the reach a gate sees is the reach of the machine composing the message, which is the machine that would do the errand. No notices, no durable state, no URLs.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state. During the rollback window the old behaviour returns: B17 is blind to reach and the session-start list goes back to 800 bytes.

---

## Conclusion

The change feeds the existing false-blocker judge the facts it lacked, using the established signal-plus-context pattern. The static prompt is unchanged, and on any error the gate runs exactly as before. Design changes from review: the rule text moved out of the static prompt into the signal-gated section (matching B23); the second-pass review narrowed reach to data reads plus looks/checks/marked self-tests, and added device-rendering checks to the must-pass list. Clear to ship once the second-pass review concurs.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (fresh context, given only the diff, this artifact and docs/signal-vs-authority.md)
**Independent read of the artifact: concur** (first read raised three concerns, below; a re-read of the fixed code concurred: "the staged changes fix all three concerns")

- Concern: clause (a) ("any read of anything the dashboard shows") could wall off legitimate phone/device checks (push arrival, how the app renders). Resolved: (a) narrowed to the DATA the server serves; device render/arrival/behaviour checks added to the must-pass list; test asserts it.
- Concern: clause (b) and the session-start line treated an operator-owned profile as consent to send on the operator's behalf, fleet-wide. Resolved: (b) covers only looks, checks and marked test messages to the agent itself; any other send is covered only by a present standing-authorization grant; the session-start line now says "look yourself" and only states how to mark a send.
- Concern: section 1 understated over-block. Resolved: the device/display shape and the broad-phrase shape are now listed above.
- Confirmed by the reviewer: account fields sanitized + JSON-encoded inside a random per-call boundary; the section renders only with the signal and reach present; both fail-open paths fail open; no tsc errors.

---

## Evidence pointers

- Founding case: topic 134088, 2026-11-09 16:20 and 17:25 PST. Live session-context read on the Studio showed `…(+9 more — GET /playwright-profiles)` at the 800-byte cap.
- `tests/unit/reach-aware-false-blocker.test.ts`: detector both sides, reach builder on the real registry (owner kept, no vault names or paths, cap, never throws, sanitization), gate prompt (section only with the signal, boundary-quoted, B17 block accepted, taste question passes).
- `tests/unit/playwright-profile-registry.test.ts`: the block now fits 11 profiles plus default under the default cap and carries the new line.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `claim-vs-evidence`. The B17 judge credited the agent's bare claim "only your browser can see it" as a genuine access limit, with no evidence of what the agent could reach.
- **`closure`:** `guard`
- **`guardEvidence`:** `{enforcementType: gate, citation: src/core/MessagingToneGate.ts#B17_REACH_SUBCLAUSE, howCaught: on the founding message the errand detector fires on "need your eye", the AGENT REACH section shows the agent key reads the conversation list, and the sub-clause makes the claimed access limit a B17 false blocker instead of crediting it}`
