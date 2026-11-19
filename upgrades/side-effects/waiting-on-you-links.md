# Side-Effects Review — Every reference to a waiting ask carries the ask

**Version / slug:** `waiting-on-you-links`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. A new named clause in the constitution (*Agent Proposes, Operator Approves* → "Every reference to a waiting ask carries the ask"), approved by Justin (topic 141385, message 145385), and the structure that applies it:

- `src/core/messageLinks.ts` (new, pure): builds the link to a Telegram message (main or Issues group), a Slack message, a Work Board card or an app conversation, and sorts the links in a message by kind.
- `src/server/routes.ts`: `GET /messages/link`; `messageLink` on the delivered answers of `POST /telegram/reply/:topicId` and `POST /slack/reply/:channelId`; `messageLink` on `GET /telegram/search` rows; the B26 fact gathering (`gatherWaitingAskFacts`) and its switch.
- `src/core/MessagingToneGate.ts`: advisory rule `B26_WAITING_ASK_UNLINKED`, rendered only when the route attaches the `waitingAsk` context; prompt id suffix `-b26`.
- `src/messaging/TelegramAdapter.ts`: `findLoggedMessages` (exact-id lookup over the retained log, one cancellable async pass). `src/messaging/slack/SlackAdapter.ts`: keeps the workspace address from the `auth.test` call it already makes.
- `src/templates/scripts/telegram-reply.sh`, `slack-reply.sh`: the success line also prints the message id/timestamp and link; previous hashes added to the prior-shipped lists so existing agents receive the scripts.
- `src/core/devGatedFeatures.ts`, `src/data/feature-ladders.json`, `src/core/types.ts`: the switch `toneGate.waitingAskLinks.enabled` (development agents live, fleet dark) and its ladder.
- `src/data/awareness/waiting-ask-links.md`: the agent awareness entry. `docs/STANDARDS-REGISTRY.md` + the Interaction family audit record. Site docs (`features/telegram.md`, `reference/api.md`).

Size: about 470 changed source lines across 12 source files, one new 180-line module, 4 new test files and 2 extended ones. Effort: 6 spec review rounds (the Tier-2 cap) plus one verification read; the review rounds are out of proportion to the size, and the reason is one late addition (showing the reviewer what a link points at) that drew three rounds of limit and cost findings. Commit/gate attempts are recorded at the end of this file.

## Decision-point inventory

- `B26_WAITING_ASK_UNLINKED` in the outbound tone gate — **add** — an advisory citation by the existing LLM authority; never a hold.
- Whether B26 is rendered for a review (`routes.ts`, before the review) — **add** — closed-set inputs only (switch, channel, kind, `liveArtefactSignals`, `noReactionPossible`).
- Whether a link can be built (`messageLinks.ts`, `GET /messages/link`) — **add** — shape checks; refuses with a named reason.
- Existing tone-gate authority, B19, the advisory reaction plumbing, the credential wall — **pass-through**, unchanged.

---

## 1. Over-block

Nothing is blocked: B26 is advisory, and a reasoned override always sends. The over-FIRE cases (a nudge that should not have happened), from the real-model runs below:

- A reminder in a private chat that says plainly no link can be built and restates the ask was nudged once in three trials on the production model.
- On the smaller Claude model, "waiting on CI", "waiting on another agent" and a reminder whose link could not be confirmed were each nudged once in three trials.

Each costs the agent one extra round (comply or override with a reason). The override reason is recorded and is the evidence that tunes the rule. No message is lost.

- **Fixed after the second pass:** a link followed by a full stop, comma or emphasis marks was counted as no message link, so a reminder that complied could be nudged again. A link in underscore emphasis, or two links joined by a comma with no space, are still misread (second-pass finding 2).

## 2. Under-block

- A reminder worded so obliquely the model does not read it as waiting on the person passes. On the smaller Claude model three bare paraphrases each passed once in three trials; on the production model none did.
- Reminders built by code or sent by a scheduled script are not reviewed by B26 at all, by design (they cannot react to a nudge; a held reminder is worse than a bare one). Tracked as feedback item fb-e3a446af-c59.
- A link to the WRONG message that happens to read like an ask passes; the judge sees the linked text but cannot know which ask the agent meant when two are similar.
- Slack, card-on-another-host and conversation links are judged on shape and the message text only.
- An agent on the fleet gets no check until graduation; it has the awareness entry.

- **A dead link of the right shape passes** (second-pass finding 5). A Work Board link on a foreign or stale address, or any `*.slack.com/archives/…` link, counts as the link; the reviewer is shown it as unconfirmed, and unconfirmed still counts. The rule checks that a link is present and what it holds when that can be read, never that it opens on the phone.

## 3. Level-of-abstraction fit

The detection is a meaning judgment, so it lives in the existing LLM authority (the tone gate) as one more rule, not as a parallel detector with its own authority. No phrase pre-filter exists anywhere: the rule is rendered by closed-set context facts, never by the message's words. The deterministic parts (link kinds, what the local log and board hold, what can be linked) are signals rendered to that authority as data. Link construction is a pure module used by the route, the send responses and the search rows; nothing re-implements a link shape. The lookup reuses the adapter's existing backwards-block reading pattern.

## 4. Signal vs authority compliance

Compliant with `docs/signal-vs-authority.md`. The only authority is the existing tone-gate model, and for this rule its power is advisory. Every brittle, cheap computation (URL shape classification, id lookup, card lookup, capability facts) produces a signal that can be reported "unavailable" and that the rule text forbids citing on its own: missing evidence is UNCONFIRMED, never a ground to fire. No deterministic check holds blocking power. The route's refusal to build an unopenable link is not a decision about a message.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The one competing-signals point (is this a reference to an ask the person still owes, and does it carry the ask?) is a judgment-candidate with its floor and arbiter declared in the spec's `## Decision points touched`: bounded action space (pass or advisory hand-back), conservative default (under-fire), fallback ending at the gate's existing availability rung. The render condition and the link-shape checks are invariants over enumerable domains or external constraints, declared there with their evidence. The two fixed limits (16,384 characters of linked evidence; 750 ms to gather it) are disclosed in-band and cannot cause a citation.

## 5. Interactions

- **B19_PARKED_ON_USER.** Its detector fires on phrases such as "your call", which a well-formed reminder can contain. B19 is blocking and has its own genuine-decision carve-out; B26's section carries one de-confliction line. Live: a linked, restated spend-approval reminder with the B19 signal present passed 3 of 3 on both models. A first ask about a low-stakes choice was cited by B19 once on the smaller model, which is B19's own existing judgment and happens with or without this change.
- **B22 / B23 / B24 / B25.** Independent sections; B26 adds one more section and does not edit the base template or any other rule's text. Controls: a clean status update passed and a message another rule should catch was caught by that rule (B1/B4), with the B26 section rendered.
- **Advisory plumbing.** B26's baseline disposition is `advisory`, so the "override could not be recorded, so block" fallback never applies to it (verified in `routes.ts` and by test).
- **Prompt id.** Reviews that render B26 are recorded under `tone-gate-sigv1-b26` / `tone-gate-sigv1-jev-b26`, so grades never mix two prompts; both pass the decision log's label clamp (test).
- **Relay scripts.** The success line keeps its `Sent N chars to …` prefix; the stall-triage parser and the existing script tests still match (run).
- **Fact gathering vs the review budget.** It runs before the review inside a 750 ms allowance and aborts the log read on expiry; a failure only drops facts (test: failed and hung lookups, review still runs, read cancelled).
- **Double-fire / races.** None: no state is written by the rule; one evidence row per citation.

## 6. External surfaces

- **The person.** Reminders from a development agent carry a link and a restatement, or the agent overrides with a reason. Telegram message links open only for chat members.
- **Agents.** A new nudge on development agents; a new line in the send output; a new route; a new instruction paragraph for every agent.
- **API.** Additive only: a new route, a new optional field on two responses and on search rows.
- **Timing.** One extra log pass, only for replies that carry a Telegram link to the agent's own chat, bounded at 750 ms.
- **Untrusted text.** The text of a linked message (possibly written by the person or a team member) enters the review prompt, JSON-quoted inside a per-call boundary, capped, and labelled as evidence for B26 only. A crafted earlier message could try to steer the verdict; the worst case inside B26 is one wrong advisory. Accepted and recorded in the convergence report's Left behind; a unit test pins that the text stays inside the quoted block.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard, approval page or form is touched. (The links this change builds point at existing console routes.)

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Link building:** pure construction from ids; the same ids give the same Telegram and Slack link on every machine. The Slack workspace address is held by the machine running the Slack adapter (machine-local: it comes from that machine's bot login); a machine without the adapter answers `409 not-configured`. Console links carry the answering machine's own operator-facing origin, the same posture as every other operator link, and are refused (`tunnel-pending`) instead of handing out localhost when a tunnel is configured but down.
- **`verified` and the linked-message facts:** read this machine's retained Telegram log and store nothing. A message another machine served reads "not in local history" / UNCONFIRMED, stated as unknown, never as wrong and never as a ground to fire.
- **The rule:** runs where the send is reviewed (the lease holder for Telegram). No new state, nothing to replicate, nothing stranded on a topic move.
- **Notices:** none are raised by this change, so there is no one-voice question.

## 8. Rollback cost

Set `toneGate.waitingAskLinks.enabled: false` (the rule is gone and prompts are byte-identical to before), or revert the PR. Additive API fields and the script's extra output need no cleanup; the script hash lists keep the shipped hashes so a later version still replaces deployed copies. Reverting deletes the awareness entry and the next update removes its text from every agent. No data migration, no state repair. The constitution clause would be removed by its own reviewed change.

## Conclusion

The change is an advisory rule in the existing authority plus additive link plumbing. Its real risks are judgment noise (measured below: about 2 percent on the production model, about 10 percent on the smaller Claude model) and the untrusted linked text in a shared prompt; both are bounded by the advisory disposition, the under-fire default, the development-agent-first rollout and the hand-graded graduation. Clear to ship behind the development-agent gate.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (a separate general-purpose reviewer session started by the author session standard-waiting-on-you-links on 2026-11-19 UTC; read-only; it read the code before this write-up and was not given the author's conclusions)

Required (outbound messaging decision; "gate"). Two independent passes were run. The first (before the pull request opened) is in "Second-pass reviewer response" at the end of this file. The second, below, was run on the tree after main was merged in on 2026-11-19 UTC, and is the review of record for the head that carries this text.

**Verdict of the second pass: Concur with the review**, after one blocking finding was fixed and re-checked by the same reviewer.

What it confirmed from the code: B26 and the new deterministic code can never hold or drop a message (advisory baseline; the "override could not be recorded" block skips it; every failure in the fact gathering only drops facts; a reasonless override is a hand-back). `GET /messages/link` validates ids as digits, builds links only from validated ids and the adapter's own workspace address, and sits behind the server's normal bearer check. Linked text is quoted inside a per-call random boundary. Every parser of the send scripts' output matches a prefix, so the appended link breaks none. The prior script hashes match main's scripts. The registry clause and the audit do not overclaim enforcement.

Its findings and what was done:

1. **Blocking, fixed.** A link followed by sentence punctuation or wrapped in emphasis ("…/138/146." or "**…/146**"), and Slack's own `<address|label>` form, was counted as "other", so the judge was told "message-links=0" for a reminder that did carry the link, and a compliant resend would be nudged again. Fixed in `src/core/messageLinks.ts` (the address stops at `|` and `<`; trailing `.,;:!?*_~` is not part of it) with a new test case. The reviewer re-ran 25 inputs against the fix and found no address it shortens wrongly.
2. **Recorded, not changed: two rarer misreads remain.** A link wrapped in underscore emphasis (`__address__`) is counted as no link at all, and two links joined by a comma with no space are read as one "other" link. Both make the code-supplied counts wrong for that message; the rule is advisory and the judge still reads the full text.
3. **Recorded, not changed: the ladder's error-rate metric cannot rise above zero.** The only error row is written in a catch the inner code never reaches (the fact gathering catches everything itself); lookup timeouts are not recorded, and an override (the real false-nudge signal) is written as a fired row. The numeric bar on the ladder is therefore met by ten citations of any quality. What decides the fleet rollout is the hand-grading in the spec's maturation plan, not that number.
4. **Recorded, not changed: citation counts read high.** A bare reminder that is handed back and then overridden writes two fired rows (one per review), so "one row per citation" is one per review, not one per message.
5. **Recorded, not changed: a link of the right shape on any host satisfies the rule.** A Work Board link on a foreign or dead address (a stale tunnel) or any `*.slack.com/archives/…` link counts as "the link"; the reviewer sees it as UNCONFIRMED, and UNCONFIRMED still counts. A dead link passes. This under-block is added to the list in section 2.
6. **Recorded, not changed: where the rule is rendered.** The origin send-policy re-review never sets "no reaction possible" (the first pass's note 7), and the post-update route also qualifies, so B26 is rendered for ship and restart narration written by a session; it is overridable there.
7. **Recorded, not changed: multi-machine.** A send relayed from a standby machine may come back without a link, and the script then prints none without saying why; the switch is read on the reviewing machine; "can link a message here" is computed against the main chat, not the topic's own group.
8. **Recorded, unsure.** Whether a narrower principal than the agent's own token (a team or phone principal) could reach `matched.text` on `GET /messages/link` was not traced; the neighbouring search route already returns message text under the same check. The added prompt size (about 4 KB of rule text and up to 16 KB of evidence) was not measured against the gate's timeout rate.

What the reviewer did not check: it did not run the model, the other test files or the route-level test, and did not read the site docs or the convergence report.

## Evidence pointers

**Tests (all run on this branch, 2026-11-18):** `tests/unit/message-links.test.ts` (19), `tests/unit/messaging-tone-gate-b26.test.ts` (14), `tests/unit/telegram-find-logged-messages.test.ts` (6, including a 90 MB / 95,000-line log), `tests/integration/telegram-reply-b26-waiting-ask.test.ts` (13, through the real reply route), the script cases in `tests/unit/telegram-reply-suppressed-duplicate.test.ts` and `tests/unit/slack-reply-delivery-id-script.test.ts`, plus the neighbouring suites listed under "Regression runs" below.

**Real-model verdicts on the boundary cases.** The real gate prompt (built by `MessagingToneGate` with the B26 section) judged 19 candidate messages, three trials each, all on the final rule text.

Production model for this gate on Echo (`codex-cli`, `gpt-6-luna`): **56 of 57 verdicts as expected.**

| # | Case | Expected | Verdicts (3 trials) |
|---|------|----------|---------------------|
| 1 | Bare reference (the screenshot's wording) | nudge | B26, B26, B26 |
| 2 | Bare, reworded ("still open on your side") | nudge | B26, B26, B26 |
| 3 | Bare, reworded ("reminder: I still need your call") | nudge | B26, B26, B26 |
| 4 | Restatement, no link | nudge | B26, B26, B26 |
| 5 | Link, no restatement | nudge | B26, B26, B26 |
| 6 | Link and restatement | pass | pass, pass, pass |
| 7 | Card link and restatement | pass | pass, pass, pass |
| 8 | Conversation link only, where nothing else can be built | pass | pass, pass, pass |
| 9 | A first ask | pass | pass, pass, pass |
| 10 | Waiting on CI | pass | pass, pass, pass |
| 11 | Already answered | pass | pass, pass, pass |
| 12 | No link can be built, restated, says so | pass | pass, pass, **B26** |
| 13 | Link points at an unrelated message | nudge | B26, B26, B26 |
| 14 | Link unconfirmed (another machine) and restatement | pass | pass, pass, pass |
| 15 | Linked, restated spend approval with the B19 signal present | pass | pass, pass, pass |
| 18 | Waiting on another agent | pass | pass, pass, pass |
| 19 | Summary with two asks, one bare | nudge | B26, B26, B26 |
| 16 | Control: clean status update | pass | pass, pass, pass |
| 17 | Control: a command handed to the person (another rule's case) | not B26 | B4, B4, B4 |

Smaller Claude model (`claude -p --model haiku`), same cases and rule text: **51 of 57.** The six misses were single trials: cases 2, 3 and 5 passed once each (under-fire); cases 10, 14 and 18 were nudged once each (over-fire). Two earlier wordings of the rule were tried and replaced after single-trial runs showed a false nudge on "waiting on CI" and on "waiting on another agent"; those runs are not counted above.

**Live Telegram run on a throwaway agent** (this branch's build, the spare test bot, the forum test group, topic 138, a spawned session using the deployed `telegram-reply.sh`): see "Live run" at the end of this file.

**Regression runs:** `tone-gate-advisory-migration`, `gate-prompts-judge-by-meaning`, `spec-approval-constitution-check`, `operator-surface-referral`, `awareness-entry-registry`, `devGatedFeatures-wiring`, `feature-ladders-coverage`, `StallTriageNurse`, `slack-reply-relay-installer`, `migration-relay-script-hash`, `standards-coverage-ratchet`, and `scripts/lint-template-sha-history.ts`: all pass.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change adds a rule and plumbing; it fixes no defect in an existing prompt, hook, config, skill or standards text, and adds no self-triggered controller (the fact gathering runs once per reviewed reply, inside the request, and sends nothing).

---

## Live run (throwaway agent, real channels, 2026-11-18 18:36–18:45 PST)

A throwaway agent was created from this branch's build (`instar init`, `developmentAgent: true`, port 4488), given the spare test bot and the forum test group ("Instar test - unread and dashboard"), and removed afterwards (`instar nuke`). The agent's deployed `telegram-reply.sh` had the same hash as this branch's template.

**Telegram, driven by a session spawned inside the throwaway agent** (the real path an agent uses; a shell outside a session is refused by the origin check), topic 138:

| Step | What the session sent | What the script printed |
|------|----------------------|-------------------------|
| A first ask | "One decision for you: should the Mini lock its screen after five minutes or fifteen? Reply "five" or "fifteen"." | `Sent 151 chars to topic 138 (message 146) link: https://t.me/c/4256079979/138/146` |
| A bare reminder | "Deploy finished. Still waiting on you for the screen-lock question I asked before." | `ADVISORY — not sent yet … Rule: B26_WAITING_ASK_UNLINKED … carries no link to the original ask (message-links=0, card-links=0) and does not restate the question or the exact reply that settles it`, exit 1, nothing sent |
| The revised reminder, `--tone-complied B26_WAITING_ASK_UNLINKED` | the ask restated with "five"/"fifteen" and "Where I first asked: https://t.me/c/4256079979/138/146" | `Sent 196 chars to topic 138 (message 149) link: https://t.me/c/4256079979/138/149`, exit 0 |
| `GET /messages/link?platform=telegram&topicId=138&messageId=146` | | `verified: true`, `matched.sentBy: agent-outbound`, `matched.text`: the first ask, word for word |

The link target was checked through the agent's own log (`verified` / `matched`), not by opening it in a Telegram client: the bot cannot open a `t.me/c` link, and a direct call to Telegram from this session is refused by the origin guard. The link's chat id and message id are the ones Telegram returned for the send.

**Slack, real test workspace, real reply route** (`POST /slack/reply/C0CG1C62HUL` on the throwaway, called directly with its token; a fresh agent that did not have Slack at init has no deployed `slack-reply.sh`, so the script's printed line on Slack is covered by its unit test, not by this run):

- A first ask was sent: the answer carried `ts` and `messageLink: https://sagemindaiworkspace.slack.com/archives/C0CG1C62HUL/p1795056154181219` (the workspace address came from Slack's own `auth.test`).
- The bare reminder: `422 tone-gate-advisory`, `notSent: true`, `rule: B26_WAITING_ASK_UNLINKED`.
- The revised reminder with that permalink and the restatement, declared complied: `200`, with its own `messageLink`.

**What the first attempt showed (kept, because it is a real finding).** On the first Telegram run the bare reminder WAS sent. The cause was not this change: a fresh agent with only `claude-code` enabled routed the reviewer to a model CLI that is not signed in on this machine, the swap timed out, and the review passed the message without a model verdict. With the model routing set the way Echo's is, the same route produced the nudge above. The reviewer passing a message while its model call is recorded as errored is filed as feedback item fb-9587b522-adc (triage: an instar defect outside this change; feedback queue).

**Left on the test channels:** topic 138 "B26 waiting-ask proof wy-1118" with four test messages in the Telegram test group, and three test messages in `#dcproof-test`.

**Not proven live:** the app channel (rule and conversation link covered by unit and route tests only); the Slack send script's printed line on a real send; a real person tapping the links.

## Found along the way (triaged, not added to this change)

- Reminders built by code are outside the new rule's reach → feedback queue, fb-e3a446af-c59.
- A fresh agent's outbound review passed a message while its model call was recorded as errored → feedback queue, fb-9587b522-adc.

---

## Second-pass reviewer response

**Concur with the review.** An independent reviewer session read the diff against this artifact, with no access to the author's conclusions, and found no blocking issue. It confirmed against the code: B26 can never hold a message (its baseline disposition is advisory, so the "override could not be recorded" block skips it; every failure in the fact gathering is caught); the attach condition uses closed-set inputs only; no deterministic check in the new code can block a send; every dropped evidence row is disclosed in-band and linked text cannot escape its quoted block; `GET /messages/link` sits behind the normal auth middleware and never returns a localhost link when a tunnel is configured; the script change keeps the "Sent N chars" prefix and the exit code on a non-JSON body.

Its nine notes and what was done:

1. A link with no topic matched that message id in any topic, and the main group and the Issues group number messages separately in one log. **Fixed:** the lookup now requires the row to be in the group the link named (test added).
2. A team member's phone row was labelled "person". **Fixed:** labelled "team-member" (test added).
3. `GET /messages/link` looked a message up with no time limit. **Fixed:** two-second limit; on expiry the link is still built and reported `unchecked`.
4. The scripts accepted any link without spaces. **Fixed:** the link must be printable ASCII starting with `https://`.
5. `1e3` and `0x10` were accepted as ids. **Fixed:** digits only (tests added).
6. A refused reasonless override was counted as an override in the evidence rows. **Fixed:** counted as an override only when it carries its reason.
7. The origin send policy never sets `noReactionPossible`. If it re-reviews a queued session message, B26 (like the other advisory rules already) could hand it back to a sender that is gone. Not changed here: it is the existing behaviour of every advisory rule on that path, and the message is held for the sender, not dropped. Noted under Interactions by this entry.
8. The log reader ignored the byte count of a short read. **Fixed.**
9. The fact gathering can add up to 750 ms before the review budget starts, which comes out of the reply script's margin before its own timeout. True; it applies only to replies that carry a link to the agent's own chat, and is measured during the development-agent period.

Under-block addendum from note 1 (before the fix): a General-form link could have shown the judge the wrong group's message. Closed by the fix.

## Effort record

Spec review: 6 rounds (the Tier-2 cap) plus one verification read. Real-model evidence: three runs on the smaller model while tuning the rule wording, then one counted three-trial run on each model. Live proof: two Telegram runs (the first exposed the throwaway's model routing, see above) and one Slack run.
