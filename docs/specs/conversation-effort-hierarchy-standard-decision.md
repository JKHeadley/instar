# Pending information while an installed machine sleeps

**Status:** Choice A approved by Justin in Telegram topic 137342 at 2026-11-05 00:37 PST (message: “Yes, A. Approved please proceed”). This ratifies the narrow exception below for the Conversations hierarchy design. The latest installed advisory check of 95 standards still reports one possible violation of **An Instar Agent Is Always a Multi-Machine Entity**; the checker may continue to flag the literal rule until Instar's standards registry records this scoped exception. A zero-flag result is not claimed.

## The collision

The ratified standard says the agent must retain all continuity-bearing information on any single installed machine if every other machine disappears. A machine that is physically asleep cannot receive a newly observed Telegram/Slack message, a newly authored owner answer, or a just-saved correction at that instant. If the awake machine later disappears before the sleeper wakes, the sleeper has to repair from the independent witness. That is information available only by contacting another machine, which the standard expressly forbids for memory-bearing state. Calling those pending items operational logs would misclassify source messages and owner decisions.

## Concrete choices

| Choice | Owner experience | Standards outcome |
|---|---|---|
| **A. Approved design: witness-backed pending intake** | The awake machine captures new sources and accepts owner work as `Saved · Waiting for MacBook`. The independent witness durably holds the pending item; the asleep member repairs before serving a current view. No pending item is called fully committed. All acknowledged graph state is on every installed machine. | Preserves usable capture and owner action while a member sleeps under the operator-ratified, narrowly scoped exception to the single-machine survivability rule for **new pending continuity-bearing information only**. |
| **B. Strict all-member acceptance** | No source, answer, or correction is accepted while any installed machine sleeps or is unreachable. The owner sees a wait state until every member is awake and durable. Telegram updates may expire before capture; some live work cannot be recovered from platform history. | Meets the literal any-single-machine guarantee for accepted information, at the cost of liveness and possible external-message loss. |

## Recommendation and boundary

**Approved A.** Keep it narrow: new information captured while a member is physically unreachable; independent witness durability before a `Saved` response or Telegram offset confirmation; no claim of all-machine commitment; repair and stale-label gate before the sleeping member serves it; owner-visible pending/cancel status; no silent promotion to verified coverage or completed work. The exception ends when every installed member has applied the item. All acknowledged graph events and erasure tombstones still require the full all-member and witness protocol in v3. If the witness is missing or unavailable, fail closed on shared writes and platform offset confirmation and show `Sync setup needed` or `Sync unavailable`.

This decision is binding for this design's specification. It does not activate or ship the feature, change Instar's global standard automatically, or make the prototype a production proof.

## Ratified scoped exception

> For newly observed continuity-bearing information while an installed member is physically unreachable, Instar may return **Saved · Pending** only after an independent witness durably holds the exact source or owner action. This is a narrow exception to the any-single-installed-machine survivability rule **only until that member catches up**. Pending information is never described as agent-wide committed, complete, or locally recoverable from the sleeping member. The member must repair it before serving a current view. A missing witness blocks both Saved acknowledgement and Telegram update-offset confirmation. All fully acknowledged graph changes, erasure tombstones, and completed answers retain the existing all-member durability rule.

**Decision record:** Justin approved A in Telegram topic 137342 on 2026-11-05 at 00:37 PST. Scope: the Conversations hierarchy design's newly observed sources and owner actions marked Pending while an installed machine is physically unreachable. Standard affected: **An Instar Agent Is Always a Multi-Machine Entity**. This is not a general relaxation of multi-machine durability; all accepted graph changes, erasure tombstones, and completed answers keep their full protocol. The standards registry and conformance checker must reflect this scoped exception before their literal result can be represented as clean.

## Registry handoff

The 2026-11-05 conformance run checked 95 installed standards and still flagged the literal single-machine rule. The operator's approval settles the product/design choice but does not itself change the installed registry. Echo's pre-action coherence gate returned `block` for editing the separate Instar source checkout from this topic because the target path is outside Echo's project. No cross-project source edit was made. The exact clause above is ready for a scoped registry amendment; Instar feedback `fb-df437009-192` records the handoff. Until that amendment is installed and rechecked, report the advisory finding transparently.

## Rejected alternative B

The strict all-member wait path was considered and not selected for this design. It would hold source intake, answer send, and correction commit until every installed member was awake and durable, risking loss of Telegram updates that cannot be fetched later. Keep this alternative as decision history; implement A's Pending labels and witness checks.
