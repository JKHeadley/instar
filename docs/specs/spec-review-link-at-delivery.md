---
title: "The spec-review link rule moves to the owner delivery point"
slug: "spec-review-link-at-delivery"
author: "echo"
parent-principle: "Signal vs. Authority"
approved: true
approved-by: "echo (agent self-approval under Approval Only Where Required: touches neither docs/STANDARDS-REGISTRY.md nor .github/CODEOWNERS; converged at the Tier 2 round cap 2026-11-28, report docs/specs/reports/spec-review-link-at-delivery-convergence.md; direction agreed by the Chief of Staff, message 1883e501; amended 2026-11-28 05:40 PT to remove check 8 everywhere per the Chief of Staff's decision, message 4a516a3b)"
review-convergence: "2026-11-28T13:51:03.033Z"
review-iterations: 6
review-completed-at: "2026-11-28T13:51:03.033Z"
review-report: "docs/specs/reports/spec-review-link-at-delivery-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# The spec-review link rule moves to the owner delivery point

## Problem statement

Check 8 of the pre-send message check (`SPEC_REVIEW_LINK` in `src/templates/scripts/convergence-check.sh`) blocks a Bash messaging command when the text hands a spec over for review without a rendered link. The hook reads the command, not the resolved recipient. So it also blocks review verdicts and handoffs that agent sessions send each other over the local bus, where no person needs a link. The workaround agents fall into, sending the body from a file, hides the message from every check.

An earlier fix parsed commands to recognise agent sends. It converged at the cap as about 280 lines of embedded Python, and the Chief of Staff rejected it (2026-11-28, message `a2863d38`): "put the link rule at the owner delivery point... and drop check 8 from the hook." The direction agreed next (message `1883e501`): "an advisory, overridable rule in evaluateOutbound next to the localhost-link guard, the missing call added to the owner-email route, check 8 removed from the hook, and the two direct-to-provider paths left with CMT-073."

## Where owner messages pass today

Read from `main` at `fafd3d914`. `evaluateOutbound` in `src/server/routes.ts` runs before Telegram replies, the post-update notice, both Slack reply routes, app replies, attention items, WhatsApp, iMessage at its validate step, the Telegram browser send and the proactive publisher. The bus route, `POST /messages/send`, never calls it, and it delivers only to agent sessions. So a rule placed here sees owner messages and never sees agent-to-agent sends.

These reach the owner without it:
1. **One-off email** (`POST /email/send-to-owner`), which runs only the credential guard. This spec adds the call.
2. **Job reports by email** (`deliver: ["email"]`): server-composed, out of scope.
3. **iMessage after validation and direct provider sends**: CMT-073, due 2026-12-08.

## Proposed design

### 1. Eligibility, and detector facts

**Eligibility is an explicit opt-in.** `checkOutboundMessage` gains an option, `specReviewEligible: true`. It is passed only by the routes that carry a session's own reply to a person:
- `/telegram/reply`;
- both Slack reply routes;
- `/app/session-reply`;
- `/whatsapp/send`;
- `/imessage/validate-send`;
- the Telegram browser send;
- `/email/send-to-owner`.

B27 applies on a send only when all of these hold:
- that option is set;
- the kind is `reply`;
- `liveArtefactSignals === true`;
- `noReactionPossible !== true`;
- the switch is on.

The post-update notice, attention items and the publisher never set the option.

**Facts.** A pure function, `detectSpecReviewHandoff(text)` in `src/core/specReviewHandoff.ts`, carries over check 8's text tests unchanged in meaning. It returns separate facts and combines nothing:
- a spec reference: a `docs/specs/<name>.md` path, or a GitHub pull request together with spec, specs or specification;
- handoff wording: review, approve, sign off, take a look, for your, ready for (the hook's pattern never matched "approve", only the bare stem; the detector matches the word, which only widens a hint);
- the link shapes present;
- for a `/docs/<id>` or `/view/<id>` link on one of this agent's own hosts (B24's host list), a local lookup, never a fetch. Views use `ctx.viewer.get(id)`. Documents use `DocumentService.facts(id)`, wired into the route context for this. The result is one of:
  - `yes`, for a document or view that exists here (owner-level existence facts only: no title is read or rendered, so no title can leak past its share; amended at build, see the side-effects review);
  - `no`, only for an id that is tombstoned or purged here;
  - `unknown`, when the id is simply absent (documents replicate by pull, so it may live on a peer).

When a send is eligible, B27 is rendered whatever the facts say. If the detector throws, the rule is rendered without facts.

### 2. A new advisory rule, `B27_SPEC_REVIEW_UNLINKED`

> **B27_SPEC_REVIEW_UNLINKED** — JUDGE BY MEANING. When the agent hands the person a spec or design to read for review or approval, the message must carry a link that opens that spec or design in a form they can read on a phone. The agent's document link and rendered page link are the usual ones. Any other link that plainly opens a readable copy of the same spec, such as a PDF or a published page, also counts. A repository path, a raw markdown file on GitHub or a bare pull request is not a readable copy. Fire when ALL hold: (1) the candidate asks the person to review, read, approve or sign off on a spec or design now; and (2) none of its links opens a readable copy of that spec or design (a link to something else does not count, and a link marked exists=no does not open). A link whose target cannot be confirmed (exists=unknown, or an outside address) counts as readable when the message plainly presents it as the spec or its readable copy. Otherwise it does not count. The detector facts below come from fixed text tests. They are hints, never proof: judge a handoff they missed exactly like one they found. PASS when the candidate reports a finished review, mentions a spec in passing, discusses this rule, quotes an old message, or carries a readable link to the spec. CITATION ORDER: if the candidate also breaks B25_SPEC_APPROVAL_UNCHECKED, cite B25. When it fires, suggest: publish the spec's plain-language companion with the spec-review publishing script, which checks that its link opens, and resend with that link and the complied reaction; or, if no link can exist, resend unchanged with the override and the reason. UNDER-FIRE BIAS: when unsure whether the candidate hands over a spec for review, do NOT fire.

- **Disposition:** `advisory` in `RULE_DISPOSITIONS` from the first release, like B26. It is not migration-exempt, and its class is `behavioral-judgment`. A baseline-advisory rule is never demoted to a hold when the quality record is dark (the advisory-unavailable branch, "SCOPE: only a MIGRATION-derived advisory"). It still nudges, saying the reaction cannot be recorded.
- **An override is re-reviewed without B27.** The gate cites one rule per verdict, and today an override of the cited advisory rule sends at once (`routes.ts`, the ack branch). That would let a B27 override skip B25 or any other rule. So new code, modelled on the sibling-confirm re-run (`runGateReview` with the remaining budget), handles a resend carrying `toneAdvisoryAck: B27_SPEC_REVIEW_UNLINKED`:
  - **The re-review:** the resend is reviewed once more with B27 not rendered and without the `-b27` suffix. It sends only if that review passes. Any hold or nudge from it stands.
  - **The chain, and no deadlock:** any advisory acknowledgment that answers a review which rendered B27 opens a chain, B27 or any other advisory rule. The chain is remembered for the pending-advisory window (10 minutes), keyed by channel, conversation and text hash, and it is written before the re-review runs. It holds every advisory rule acknowledged on that text, each with its reason. Each resend in the chain is reviewed with all of them left out, both from the prompt and from the set of citations the call accepts. Each excluded rule is recorded on the decision. A resend sends only when such a review passes, or when it reaches the gate's documented fallback. Inside the chain, an acknowledgment never sends on its own. So B27, then B2, then B25 ends in B25's hold. So does B2, then B27, then B25. No rule that was never cleared is skipped.
  - **No verdict on the re-review:** it follows the gate's existing fallback for that send. That is the degraded result unless fail-closed is set, the same as any first review.
  - **Grading order:** the B27 override is recorded as `override` only when the re-review lets the message send, never before.
  - **Cost:** one extra review per B27 override, and up to two more under the gate's own retries.
- **B27 is valid only where it was rendered.** `interpret()` checks citations against the per-call set of rendered rules (instead of the global `VALID_RULES`) for B27 and for every rule a chain leaves out. The static prompt template is hashed for the benchmark and stays unchanged; a left-out rule is instead named in an ALREADY ACKNOWLEDGED section that says not to cite it (amended at build). A B27 citation on a review that did not render it is not a pass, because that review never cleared the other rules. It takes the gate's existing invalid-citation path: one retry, then that path's hold (or, under `tiered`, delivery on the operator's own channel). On a first review this never produces a B27 nudge. On a re-review, it means an override can wait for a valid verdict, the same as any invalid citation. Each case is counted in evidence as `reason: stray-citation`, so a model that keeps citing a rule it was not shown is visible.
- **B24 and B25:** B24 may nudge a `/view/` link toward a document, and B27 accepts either, so they never conflict. B25 stays a hold, and the re-review keeps it reachable.
- **Prompt id:** a review that renders B27 appends `-b27` after any `-b26`, so grades never mix prompts. This splits the tone-gate benchmark window (due 2026-12-05) at the B27 release, and its report states the split.
- **Cost:** about 300 prompt tokens on each eligible review while the switch is on. The re-review costs one extra review per B27 override.

### 3. The owner-email route calls the same check

`POST /email/send-to-owner` gains a `checkOutbound` dependency, wired to `checkOutboundMessage(subject + "\n\n" + text, 'email', res, …)`. It sits behind its own switch (section 4).

- **Options:**
  - `topicId` (kept, so the review has the conversation's context, the recipient class, the standing authorization and the interactive lane);
  - `attributionConversation: 'email:<topicId>'`;
  - `messageKind: 'reply'`;
  - `liveArtefactSignals: true`;
  - `specReviewEligible: true`;
  - the four tone-advisory keys.
- **Duplicate check:** for `email`, the duplicate check does not compare against the topic's chat messages. "Email me that" repeats a chat report on purpose, and B9 is a hold on the fleet. Email has no earlier-email comparison either. The outbox keeps no text to compare against.
- **Revision memory:** `notePendingAdvisory` and `takeRevisionOf` gain a channel argument and are keyed by channel and topic. Without it, an email nudge and a chat reply in the same topic would credit each other.
- **Order:** the email `id` is minted first (it already is, before the lease decision). The check runs after the request is validated and the conversation is confirmed to have no other readers, and before the lease decision. A forward to the lease holder happens only after a pass. The holder's `email-send-forward` handler does not judge again.
- **Metadata:** an optional `metadata` object carrying only the four tone-advisory keys. That matches the session-only routes (Slack session-reply and the browser send), which keep `allowDuplicate`, `allowDebugText` and `allowLocalhostLink` out of a session's reach. Any other key is a 400. A localhost-link refusal on `email` says "remove the link or replace it with the tunnel address" and offers no metadata escape.
- **Retries (existing, unchanged):** today each request mints a fresh id, so a retry after a lost response can send twice, gate or not. The timeout override below removes the cause this change would add. A caller-stable idempotency key is a separate fix, tracked as CMT-074.
- **Timeout:** `'/email/send-to-owner'` joins `buildRequestTimeoutOverrides` (`src/server/middleware.ts`) at `OUTBOUND_MESSAGING_TIMEOUT_MS`. The gate budget, the organization check and the forward together exceed the 30-second default. Without the override a client would time out while the email still went out, and a retry would send it twice.
- **Awareness:** the B27 awareness entry, `src/data/awareness/spec-review-link-at-delivery.md` (one entry for both switches, amended at build), says the email is checked like a chat reply, and gives one example of each answer to a nudge, both carrying the nudge's `decisionRef`:
- **Agree:** revise the text (for B27, add the readable link) and resend with `metadata.toneAdvisoryComplied`.
- **Disagree:** resend the text unchanged with `toneAdvisoryAck` and `toneAdvisoryAckReason`.

### 4. Two switches

Both are entries in `src/core/devGatedFeatures.ts` and keys in the `toneGate` config type. Each is read live, like B26's `waitingAskLinksOn`. Unset means live on development agents and dark on the fleet. Each has a rung in `src/data/feature-ladders.json`.

- **`toneGate.specReviewLinks.enabled`** covers B27.
- **`toneGate.ownerEmailCheck.enabled`** covers the email call. It is separate because on the fleet the advisory migration is off, so the gate's other judgment rules are holds there. Development agents, where those rules are nudges, cannot show what fleet email would meet.

### 5. Check 8 leaves the hook everywhere (chosen trade-off)

The `SPEC_REVIEW_LINK` block is deleted from `src/templates/scripts/convergence-check.sh` on every agent in this release. The script is rewritten on every update, so no migration is needed. The other checks (1 to 7, 6b and 9) are unchanged. **The trade-off, chosen by the Chief of Staff** (2026-11-28, message `4a516a3b`): fleet agents lose the link reminder until B27 goes live there. The spec-converge skill is installed on every agent (`src/commands/init.ts`), but by its own text it is for the instar-developing agent only, so the fleet barely uses the reminder. Meanwhile the misfires block real agent-to-agent work on every agent today. The rejected alternative, keeping check 8 on the fleet behind a config guard, would have kept those misfires and added a second copy of the switch resolution.

Check 8 never saw owner email, because the hook's trigger pattern does not match the email route. So removing it opens no email gap.

## What changes, and what is given up

- **Senders on a development agent:** agent-to-agent sends are never blocked for a missing link. An owner handoff gets a nudge, from any tool, and owner email is checked like a chat reply.
- **The fleet:** no spec-link reminder until B27 goes live there, and no more misfires (the chosen trade-off, section 5).
- **Given up:** with no tone gate installed, everything passes. On provider failure, the gate's existing fallbacks apply to B27 as to every rule. The degraded result passes clean prose unless `toneGate.failClosedOnExhaustion` is set, and the fail-open paths let text through. That floor is the operator's setting, unchanged here, and evidence keeps those sends apart (section 6). An agent can also send an unlinked handoff by overriding with a recorded reason.

## 6. Evidence

These are rows in the existing feature-evidence log under `toneGate.specReviewLinks`. Context values are primitives (link shapes are joined into one string). Ladder metrics filter on `reason`, so none of these rows counts as a grade.

- **Fires:** a `fired` row per B27 citation, as B26 does.
- **Passes** (`kind: outcome`):
  - `reason: signal-passed` for an eligible pass where the detector found a reference and handoff wording;
  - `reason: sampled-pass` for one in ten eligible passes with no hit;
  - `reason: unjudged-pass` for any pass marked `degradedToDeterministic`, `failedOpen`, `failedOpenOperatorChannel` or `budgetExceeded`. These are never counted as judged.

**What a row carries:** the channel, the conversation, the time, the link shapes, the `decisionRef` when present, and the full SHA-256 of the judged text. Email rows also carry the email `id`. The row holds no text.

**Where the text is read:** the gate's own decision record, for chat and email alike. That covers a nudged draft that was never delivered and an email whose outbox text is already deleted. A fire is also read through its resend. The capture rules:
- **Scope:** body capture is passed per call, only on B27-eligible reviews, and only on agents explicitly enrolled for measurement (`toneGate.specReviewLinks.captureBodies: true`, set by hand on the measured development agents, absent everywhere else). The global `toneGate.recordCandidateBody` is untouched, so other traffic, team messages included, is never captured by this.
- **Limit:** `buildToneDecisionContext` clamps every capture to `TONE_CANDIDATE_BODY_MAX_CHARS` (4,000), so it gains a separate fixed ceiling of 20,000 characters, used only for these captures. That covers email (16 KiB plus subject) and every chat reply. Other calls keep 4,000. `scrubForStore` still runs. A row that was cut, withheld or redacted where the link would be is marked ungradable. This relaxes the store's "never an unbounded archive" rule on purpose, within bounds: enrolled agents only, eligible reviews only, a fixed ceiling, and 30 days. The review context gains a field to carry it.
- **Retention:** `provenance.retentionDays` is 30 on the measured agents during the dark window. That setting covers their whole decision record, not only this point, which is stated as accepted. The replay copies email rows into its private document as they arrive, so none ages out before the 20 are reached. The record is machine-local, and the reader reads it weekly on each machine.
- **Budget:** the tone-gate point's daily budget (500) is checked against eligible volume. Rows dropped past it are counted as `dropped`, kept apart from the one-in-ten samples, and left out of the recall weighting. A day with drops is named in the report.
- **After fleet-on:** this capture ends, and B27 is audited from the gate's standard decision record like every other rule.

A row whose text cannot be found, or was cut anyway, is counted as ungradable and reported, never graded. Tests cover a standby email nudge, then a corrected resend, recovered after the outbox row is terminal.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| `B27_SPEC_REVIEW_UNLINKED` (new) | judgment-candidate | **Arbiter:** the tone gate's LLM judgment over the whole message, with the facts as hints. **Floor:** an advisory nudge. The agent may resend with a reason, and that resend is re-reviewed without B27. **Default:** under-fire. **Fallback ladder:** detector throws → judged without facts; provider failure → the gate's existing fallbacks; no gate, switch off or not eligible → pass through (deterministic rung). |
| Detector facts, eligibility opt-in, override re-review (new) | invariant; basis: enumerable-domain; evidence: the facts are three fixed text tests and a local id lookup with values yes/no/unknown that gate nothing; eligibility is a closed list of seven routes that set one option; the re-review omits a recorded set of acknowledged rule ids | Each keeps every other rule reachable or only adds hints; none decides what a message means. |
| Owner email passes `evaluateOutbound` (new) | judgment-candidate, inherits the gate | The same arbiter, floor and fallbacks as every owner route, behind its own switch. The credential guard still runs. |
| Two switches (new) | invariant; basis: enumerable-domain; evidence: each resolves from two recorded config values (the flag: unset/true/false; developmentAgent) through `resolveDevAgentGate` | The standard development-agent switch, with both-sides wiring tests. |
| `SPEC_REVIEW_LINK` in the hook (removed) | invariant; basis: external-constraint; evidence: the Chief of Staff's decision (message `4a516a3b`) to remove it everywhere | A keyword veto with no recipient knowledge, removed on every agent. |

## Verify the State, Not Its Symbol

- **Symbol:** the gate's B27 verdict, helped by the facts.
- **State:** the person is asked to read a spec they cannot readably open.
- **Corroboration:** the route. Only person-facing routes opt in, so the recipient is a fact. The model judges whether this is a handoff and whether a link opens the spec. An own-host link is checked to exist locally.
- **Symbol present, state absent:** a passing mention, or a link that opens something else. Both are judged by meaning, and at worst the agent gets a nudge it can override.
- **State present, symbol absent:** a handoff in other words. It is rendered and judged anyway, and misses are sampled.
- **Unmeasurable:** the gate does not fetch links, and a link on another host or machine is `unknown`. Unjudged passes are recorded as unjudged, and unrecoverable rows are counted.

## Multi-machine posture

unified. Code and config keys ship to every machine. Evidence uses the existing per-machine log, read alongside the delivering machine's history (section 6). Each message is judged where the session sends it, and an email before its forward.

machine-local-justification: not applicable. No new machine-local surface.

## Frontloaded Decisions

- **Signal plus LLM rule, not a deterministic nudge beside the localhost-link guard:** a deterministic nudge would need override recording outside the graded one, and would keep the keyword-veto shape.
- **Settled here:**
  - advisory;
  - rule number B27;
  - any readable link counts;
  - eligibility by route opt-in;
  - an override is re-reviewed;
  - two switches;
  - the email metadata carries the four tone keys only;
  - email kind `reply`, with `topicId` kept;
  - check 8 leaves the hook on every agent in this release (Chief of Staff's decision);
  - B27-eligible reviews capture their body during the dark window (section 6), and the capture ends with the switch's fleet-on release;
  - direct-to-provider sends and job email are out of scope.

## Lessons and foundation

- **Lessons applied:**
  - Intelligence Infers, Keywords Only Guard and Signal vs. Authority: keyword tests become hints for an overridable judgment at the route;
  - Gate latency vs client timeout: the email route gets the messaging timeout;
  - A Dark Feature Guards Nothing: weighed, and the fleet's gap accepted by the Chief of Staff as the chosen trade-off (section 5).
- **The foundation, one layer down:**
  - one rule per verdict, hence the re-review;
  - revision memory keyed by topic alone, hence the channel key;
  - fail-open passes, hence the separate evidence.

## Maturation plan

- **test-agent-live:** the throwaway live proof and the pre-release replays.
- **dev-agent-live:** both switches are live on development agents from the release. Check 8 is gone everywhere in the same release.
- **graduation criterion:** a judgment on the evidence, made by me and then the Chief of Staff, two readings that must agree. The second reading is a fresh reviewer session given the evidence document, not my conversation. It uses development agents whose quality record is live. The numbers below are not a score that grants graduation: crossing one needs a written reason to go ahead anyway.
  - **precision:** the share of declared-reaction B27 grades graded right, with a 70% mark. Nudges nobody reacted to are counted and reported beside it. Fires are read through their resend, and a fire never resent is counted as such.
  - **recall:** every read handoff is labelled twice: once for whether it is a handoff, once for whether its link was adequate. Recall counts only the handoffs that warranted B27 (no adequate link), from fires judged right, `signal-passed` rows and `sampled-pass` rows. Sampled rows are weighted ten to one, and the groups are reported separately. Links whose target could not be resolved are reported apart. Eligible verdicts that cited another rule are sampled one in ten as well (`reason: other-rule`). The report says how often B27 found the missing link, and how often another rule (B25 above all) already stopped the send. Recall is computed over the gradable population, and the count of eligible decisions with no gradable evidence is reported beside it. There is a mark at 5 warranted handoffs, below which the evidence is too thin to judge, and a mark at a two-thirds weighted catch rate.
  - **regressions:** any agent-to-agent send blocked by a spec-review rule.
  - **against the default:** the review compares the period with pass-through, meaning what the caught handoffs would have cost without a link.
  - **email:** graduates separately. It needs the replay's hold rate, under the fleet dispositions actually intended at fleet-on (including the migration-exempt holds), to be accepted by the Chief of Staff. A migration setting is not a substitute.
- **fleet:** a later release turns each fleet default on after both readings agree. The review is a tracked commitment with a beacon, due two weeks after release and weekly after that until it is decided.
- **dark-window:** at least two weeks on development agents, with the fleet dark and without a link reminder (the chosen trade-off).
- **ladder:** toneGate.specReviewLinks
- **owner-email entry:** toneGate.ownerEmailCheck. Both are dev-gated switches with rungs in the feature-ladders file, each followed by its own fleet-on release after graduation.

## Rollback

- **To stop B27:** set `toneGate.specReviewLinks.enabled: false`. **To stop the email call:** set `toneGate.ownerEmailCheck.enabled: false`. Both are read live.
- **To restore check 8:** a revert release, since it is deleted from the hook template.

No state needs repair either way.

## Open questions

*(none)*

## Testing

Every test that pins the gate's rules is run whole, found with `git grep -lE "VALID_RULES|RULE_DISPOSITIONS|RULE_CLASSES|ADVISORY_MIGRATION_EXEMPT" tests/`.

- **Unit, detector (`tests/unit/spec-review-handoff.test.ts`, new):** each fact on both sides, from the old Category 8 rows, plus the exists lookup.
- **Unit, tone gate:**
  - B27 is listed, `advisory`, not exempt, and judge-by-meaning;
  - an eligible reply with no hit renders it; a detector throw renders it without facts; switch off, post-update, attention and the publisher render nothing;
  - the `-b27` id appears exactly when B27 is rendered.
- **Unit, override re-review:**
  - a B27 verdict, then a B27 ack whose re-review cites B25: nothing sends;
  - the same with a passing re-review: it sends;
  - the chain B27, then an ack, then a re-review citing B2, then an ack, then a re-review citing B25: held; and the same chain ending in a passing review: sent, with B27 never cited again;
  - the reverse order B2, ack, B27, ack, B25: held; and a model citing B2 again after it was acknowledged: treated as a stray citation;
  - a B27 citation where it was not rendered: retried once, then the existing invalid-citation outcome, counted `stray-citation`, and never a B27 nudge. This covers a stray B27 followed by a valid B25 hold (held), and two stray citations in a row (the no-verdict policy);
  - a revision credit never crosses channels.
- **Unit, switches:** both new entries pass the dev-gate wiring test.
- **Unit, hook (`tests/unit/convergence-check.test.ts`):** each old check-8 blocking shape now passes the hook on any config. The other checks keep their rows.
- **Integration, email (`tests/integration/email-send-to-owner-tone.test.ts`, new):**
  - switch off: today's behaviour;
  - on: a `422 tone-gate-advisory` with a `decisionRef`; an ack with a reason is accepted;
  - a fifth metadata key is a 400;
  - a loopback link gets the email-specific refusal;
  - a standby judges before it forwards, and the holder does not judge again;
  - the route carries the messaging timeout;
  - an email over 4,000 characters with its only link at the end is recovered whole from the decision record;
  - an email repeating a recent chat message is not a duplicate.
- **Integration, evidence lookup:** the cases in section 6.
- **Pre-release replay (shadow evidence):** the whole gate prompt with B27 rendered runs offline, on the gate's model. It covers:
  - 30 days of owner replies from conversations the owner alone reads on the development agent;
  - the 85 kept bus sends, read on the M5 where they are stored;
  - hand-written texts that break both B25 and B27, to measure how often the model cites B27 first.

  Email has no past store (the outbox deletes text), so its fleet evidence is collected going forward: captured development-agent emails are replayed offline under fleet dispositions, and email fleet-on needs at least 20. Capturing them needs both switches on. Results go into a private document. The PR gets only counts, rates and the document's link. Over a quarter of fires wrong means the rule is revised before release, unless the document gives a written reason.
- **Live proof before merge:** on a throwaway agent with the real gate and both switches on, through demo channels only, with nothing to the real operator.
  - **Telegram and Slack:** an unlinked handoff is nudged; the same text with a document link sends; an override with a reason sends.
  - **Agent bus:** the unlinked text goes through, and the installed hook no longer blocks it.
- **Owner email, evidence limit:** a live send needs a sending account and an owner inbox, and the only one is the real operator's. Email is proved through the full HTTP pipeline with a fake transport, not live. The PR states this.
