# Side-Effects Review — The Person Decides; the Agent Does the Rest (1.x counterpart of Rule 120)

**Version / slug:** `person-decides-counterpart`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra, on the final diff`

## Summary of the change

A constitution text change. A new article, *The Person Decides; the Agent Does the Rest*, joins the Interaction family as a tree node under *Agent Proposes, Operator Approves*, which gains the back-link. It carries the same obligation as 2.0 Rule 120 (instar-2 PR 190): the agent does the research, account management and operation, and the person only approves or declines, asks for changes, or supplies a credential. It says plainly that nothing enforces it yet and names the two checks owed. The alignment map gains the pair's rows, the generated hierarchy block is regenerated, the Interaction family audit is re-recorded, and the article-count assertion moves from 94 to 95.

## Decision-point inventory

None added. No code path changes.

---

## 1. Over-block

No block surface. The article names an outbound check for later building; it builds none.

## 2. Under-block

Until the outbound check and the per-service live proofs exist, an agent can still hand the person a setup task and nothing stops it. The article says so in **Applied through**.

## 3. Level-of-abstraction fit

A child of *Agent Proposes, Operator Approves*: that parent governs the shape of one ask, and this states the whole boundary of what may be asked. *No Manual Work* is the other natural parent, but its title cannot be named in the tree-node syntax (it contains emphasis markers), and the placement prose names it.

## 4. Signal vs authority compliance

Compliant: the article creates no authority. The owed outbound check would be a hold on a message, to be designed under `docs/signal-vs-authority.md` when it is built.

## 5. Interactions

*Self-Unblock Before Escalating* still decides whether the person is asked at all. *Sovereignty* keeps "if it's the human's, ask", which the alignment map already lists as conflict 5; acting in the person's accounts happens inside the authority they granted, and this change does not resolve that conflict. *The Agent Carries the Loop* (follow-through) is unaffected.

## 6. External surfaces

None at runtime. The published constitution text changes.

## 7. Multi-machine posture

Repo-tracked text; unified.

## 8. Rollback cost

A revert of the text, the map rows, the count assertion and the re-recorded Interaction audit.

## Second-pass review

**Reviewer:** independent cross-family reader, codex-cli on gpt-6-astra

Read the final diff and the 2.0 rule book with Rule 120. Six findings, all low. No drift from Rule 120: "within the authority granted" makes explicit what 2.0 Sovereignty already imposes, and dropping the executive-assistant analogy changes no obligation. Placement sound and the overlaps complementary; *Never a False Blocker*'s physical-action and CAPTCHA allowance is a tension that *Self-Unblock Before Escalating* already has with the same ladder, and this change imports Rule 120 rather than resolving it. No enforcement overclaim. Map counts and rows independently re-counted and correct. Two wording nits applied: the overview now says "no runtime enforcement changes" rather than "agents behave the same", and this artifact says "same obligation" rather than "same wording". Tree-parentage, insertion-placement, hierarchy and countdown checks all pass. Concur with the review: VERDICT YES.

## Counterpart

instar-2 PR 190 adds Rule 120 with the same obligation, and is the master, so it merges first.

## Test expectations changed

`tests/unit/standards-coverage-ratchet.test.ts`: article count 94 to 95.
