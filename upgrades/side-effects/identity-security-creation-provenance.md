# Side-Effects Review: a change you ask for is confirmed where you asked it

**Version / slug:** `identity-security-creation-provenance`
**Date:** `2026-11-19`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Bug fb-ac3d2e79-2a4 (Justin, 2026-11-18): the agent created a conversation at the owner's request, and his later request to set its model was refused (`no-bound-operator`). A topic learns its operator only from a first message typed in it.

- **`POST /topic-profile/:B/propose` accepts `confirmIn: A`** (the existing §10.1 propose lane).
  - The server-rendered proposal ("For the conversation "<B>": …") is posted in A, and the confirmation slot is armed in A with target B.
  - The owner's live, authenticated "yes" in A applies exactly that change to B (`crossTopicConfirm`), audited as `owner-confirmed-in:<A>`.
  - Only everyday run settings (model, model tier, thinking mode, effort).
- **Eligibility** (`crossTopicEligible`) is checked when the proposal is armed and again when the yes arrives:
  - the confirmer is the configured owner;
  - A is the owner's own conversation (not shared);
  - B is known, unbound or verified-bound to that owner, and not confined to a member.
- **Refusals.** An arm-time refusal about B is also told to the owner in A.
- **The switch.** `security.crossTopicConfirm.enabled`, on the development-agent gate: live on Echo, dark on the fleet.
- **The creation record.** `POST /telegram/topics` accepts `onBehalfOf`, identity-checked and recorded in `state/topic-creation-provenance.json` as a message the agent linked, with `authorship: 'unverified'`. It grants nothing, is never posted, and is read through `GET /topic-creation-provenance/:topicId` (ids and times).

## Decision-point inventory

- The cross-conversation confirmation (eligibility and the yes).
- The creation record (grants nothing).

## 1. Over-block

The owner gets today's path (send one message in B) whenever any of these holds:
- A is shared with the team;
- B is a candidate binding;
- the team record is unreadable;
- the change includes framework or escalation;
- the switch is off.

## 2. Under-block

The owner could say "yes" to a proposal they misread. The proposal is the server's own plain rendering of the exact change, scoped to everyday settings, and limited to the owner's own conversations.

## 3. Level-of-abstraction fit

- **The eligibility rule:** one pure function, in the core module.
- **The lane and the confirm handler:** reused, not duplicated.
- **The write surface:** takes one new input, used only by the confirm handler.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No: deterministic checks over enumerable inputs (ids, bindings, the team record), with the authority being the owner's live, authenticated yes to an exact rendered change. No judgment over meaning is made in code.

## 5. Interactions

- **Topic-profile propose lane:** a new optional field. Without it, behaviour is identical.
- **Confirm slots:** an optional target.
- **Write surface:** an optional `crossTopicConfirm`.
- **Telegram adapter:** a read-only lookup (`findTopicMessage`).
- **Dev-gate registry:** one entry.
- **Awareness:** one entry.

## 6. Rollback

Turn the switch off (cross-conversation proposals refused at once, and a pending yes refused when it arrives), or revert the commit. `state/topic-creation-provenance.json` is left behind and read by nothing.

## 7. Evidence

- **Unit:**
  - `tests/unit/identity-creation-provenance.test.ts`: the five eligibility checks both ways; `checkCitation` both ways; the record (`authorship` unverified, reuse appended, asserted session).
  - `tests/unit/topicProfileWriteSurface.test.ts`: an operator write to an unbound topic only with `crossTopicConfirm`, audited; someone else's topic still refused; the token path unchanged.
  - `tests/unit/topicProfileIngress.test.ts`: a slot carries its target.
  - `tests/unit/devGatedFeatures-wiring.test.ts`: the switch is live on a dev agent and dark on the fleet.
- **Integration** (Local Verify): `tests/integration/topic-profile-routes.test.ts`:
  - proposal posted to A and armed in A with target B, nothing written yet;
  - refusals for a non-owner, B bound to someone else, and a candidate binding, with the owner told in A when B is the problem;
  - dark switch (503); malformed `confirmIn` or non-everyday fields (400);
  - the lane unchanged without `confirmIn`.
- **E2E** (Local Verify): `tests/e2e/topic-profile-lifecycle.test.ts`. The record route answers; `confirmIn` is refused by name through the production wiring.
- **Live:** the spec's dev-agent-live proof on Echo through real Telegram, before Justin is told.

## Second-pass review

An independent reviewer subagent read the v5 code cold.

**Round 1: DO NOT CONCUR.** Fixed, with tests:
1. **The switch wasn't re-read** when the yes arrived (high). It is now read live in both places.
2. **No test drove the authority-granting confirm branch.** It is extracted as `applyCrossTopicConfirm` and unit-tested, and the e2e assertion is now exact.
3. **The agent controlled the timing of the yes in A.** Any later message into A now disarms the proposal.
4. **The arm-time notice had no rate limit.** It is now deduplicated per pair and reason over 10 minutes.
5. **The proposal's wording was ambiguous.** It now names the other conversation, and names are cleaned.
6. **The refusal wording was wrong** for the shared-source and switch-off cases. Each reason has its own sentence.
7. **A replaced proposal wasn't visible.** It now says so.
8. **The field rule was enforced only at the route.** The surface enforces it too.
9. **The lookup budget is lowered** to 16 MB.

A pre-existing ordering gap (synthetic message ids) was filed separately as fb-733eef65-83d.

**Round 2: DO NOT CONCUR,** for one item. The re-sent echo ("Please confirm this version") disarmed its own proposal. It is fixed by clearing the recorded echo id before the re-send, with a test. File sends now disarm too; the remaining button sends and sends from other machines are written into the spec's known limits.

**Round 3: CONCUR.** The reviewer's own run of the four unit files passed (390 tests).

## Class-Closure Declaration

**In the trace:**
- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** no loop and no retry. One proposal per request (the propose lane's existing churn limit applies), one write per owner yes, one bounded (16 MB) log read per creation link.

## Instruction-file size (2026-11-19 05:40Z)

Main's core instruction file is at its size limit: `CLAUDE_MD_CORE_BUDGET_CHARS`, 84,000. PR 3412 failed on it, and every new awareness title costs characters in the capability list. This PR therefore shortens two of my older entry titles, "Dashboard session token" and "Dashboard session revocation" (the SEC-046 entries). The list cuts titles at 60 characters, so this saves about 57 characters. It also gives its own entry the short title "Cross-chat confirm". The net change is about 37 characters fewer than main. Entry bodies are unchanged.

## Guard fixes on the merge with main (2026-11-19 06:45Z)

- `/topic-creation-provenance` is classified in `CapabilityIndex.ts` as a prefix agents reach through the awareness entry, not discovery.
- `security.crossTopicConfirm` has its ladder entry in `src/data/feature-ladders.json`:
  - **ran:** cross-conversation changes applied;
  - **harm:** the share of proposals disarmed by a later message before the owner answered.
- So the ladder can read them, the armed, applied and disarmed audit rows now carry `crossTopic: true`.
- The spec's ladder line names the entry id.
