# Side-Effects Review — Frontier design and review, stage 3: rule B26 at the approval point, the Work Board judge, and the publish script

**Version / slug:** `frontier-design-review-stage-3`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (an outbound message block/allow decision is touched)`

## Summary of the change

Build stage 3 of `docs/specs/frontier-design-review-standard.md` (approved 2026-11-17, topic 144319, message 144458). Tier 2. Builds on stages 1 and 2.

- **Rule B26 (`B26_DESIGN_APPROVAL_UNREVIEWED`)** joins B25 in the outbound gate: `signal-driven`, `blocking`, in `ADVISORY_MIGRATION_EXEMPT_RULES`. Rendered only where the standard is on (`resolveDevAgentGate`), never for health alerts.
- **Shared definition.** What an approval request is now lives in one constant (`src/core/approvalRequestDefinition.ts`) used by B25 and B26; B25's rendered text is byte-for-byte unchanged (checked).
- **Code-computed evidence** (`src/core/designApprovalEvidence.ts`): before the gate's LLM call, code finds each `(Review record <12 hex>)` reference in the text and builds an entry from the ledger index (this machine's rows plus peers' cleaned rows, `DesignRunsPeerCache`, refreshed in the background at most once a minute): title, outcome (`reviewed`, `no-reviewer-reachable`, `not-reviewed`, `changed-since-review`, `unknown-reference`, `records-unavailable`), times reviewed, writers, verdicts, and whether the text contains the record's line as it renders now (whitespace and emphasis ignored). For this machine's rows the file is re-read (cached by mtime and size); a peer's path is never opened.
- **Work Board.** `judgeSpecApprovalAsk` takes the same evidence and applies both rules in its one call; a B26 fire returns 422 `design-approval-unreviewed` listing every rule that fired. Without evidence (standard off) it is exactly B25 as before.
- **`publish-spec-review.mjs`** puts the review line, introduced as "Review record for the full design, <title>:", and a constitution-check line into the message it composes and at the top of the rendered overview.

## Decision-point inventory

- **Is this outbound text a spec or design approval request that lacks its review?** — add: judgment point (B26) inside a floor: hold or pass only; the reference lookup, the line check and the fingerprint re-check are code; under-fire bias on "is it a request" and "is it a different design".
- **Is this agent-written Work Board card such a request?** — modify: the existing card judge, now both rules in one call.

## 1. Over-block

- A message mentioning a design's approval in passing could be read as a request; the definition and pass list are B25's, live for two days, and false holds are counted at each rung.
- A design reviewed on a peer needs one re-send after the peer rows arrive (background refresh, at most a minute).
- A line fetched before a further driver run no longer matches the record ("Reviewed 2 times" vs 3) and holds until re-fetched; the suggestion says to take the line from `GET /design/review`.
- Every hold is cleared by the agent alone (one `/design-review` run); an agent with no reviewer at all still clears (`no-reviewer-reachable` with its line).

## 2. Under-block

- When the gate's LLM is unavailable and the operator-tier delivery rule applies, the message goes out unjudged, as for every rule.
- A request split over two messages, or phrased so the judge does not read it as a request, is the residual B25 shares.
- A design reviewed on another machine is not re-read here (the entry says so).
- Design work started by routes the standard does not route (decision 13) is still held at approval, which is the catch; work built without ever asking approval gets neither.

## 3. Level-of-abstraction fit

B26 sits in the existing outbound gate beside B25 and in the existing card judge, the two places a request reaches the operator. Exact lookups are code; meaning is the LLM's. No new gate, no new route.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`. The evidence entries are signals computed by code; the blocking authority is the outbound gate's LLM judgment (B26) inside the floor above, exactly the B25 pattern. No brittle check holds anything by itself: a missing reference, a stale line or an unknown reference is shown to the judge, which still decides whether the text is a request at all.

## 4b. Judgment-point check

The competing-signals point (is this a request? for which design?) is an LLM judgment within a floor; the evidence fields are invariants.

## 5. Interactions

- B25 and B26 both apply to an approval request; the gate returns one rule, so when both apply the judge cites B25 and the suggestion names the one `/design-review` run that clears both (rule text).
- The stage-1 relay skip is unchanged: a tokenless standby relaying to the lease holder is gated by the holder, which computes evidence from its own rows plus peers' (so a design reviewed on the standby is found through the peer rows).
- The Work Board 422 for B25 alone is unchanged in shape; a B26 fire uses the new error name.
- The evidence step reads the ledger only when the text carries a reference, then one re-read per referenced own file (cached by mtime and size, skipped above 2 MB) before the gate call; no network wait. A fault in it reaches the judge as `records-unavailable` for each reference (which holds), never as "no reference".

## 6. External surfaces

Operators on development agents see approval requests carrying the review line (the agent adds it). Fleet agents: nothing until graduation. The publish script's message gains two lines.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or form.

## 6c. Agent proposes, operator approves

`src/core/approvalRequestDefinition.ts` only moves B25's existing definition of an approval request into a shared constant (text unchanged); it grants nothing. The operator still gives one approval of a request the agent prepared: they construct nothing and fill in nothing. The provenance line the request must carry is authored by the server from the review records (`GET /design/review` renders it from structured rows), never agent free text, and code checks that the line in the request is the record's current line word for word. The agent's own words around it stay its own, judged by the gate as before.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Ledger rows: proxied-on-read** through `GET /design/review/runs` (stage 2), merged here as a union keyed by machine and run id; peer rows cleaned and statuses recomputed locally. A peer speaks only for its own rows: a row whose machine id is not the serving peer's (this machine's id included) is not taken, so no peer can make this server open a path or add a run under another machine's name.
- **Holds go only to the sending agent**; no operator-facing notice, nothing that strands on a topic transfer.
- **On/off** follows `developmentAgent` per machine until graduation.

## 8. Rollback cost

A release with the standard off for every agent stops B26 and leaves the card judge as B25 only; the ledger, routes and driver keep working. A held request is delivered on re-send.

## Conclusion

Stage 3 closes the loop the spec exists for: an approval request for a design reaches the operator only with a line written from the record of the review of that exact text. Stage 4 (awareness, migrations, constitution article) follows.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (Claude Opus 5.5), read-only over the diff and the spec

**Independent read of the artifact: concur** after its round-1 concerns were fixed:

1. (medium) A peer row claiming this machine's id was taken whenever the local ledger had no row under that id, so the server would open its path in the send path and derive its passes as its own. Fixed: the cache drops rows naming this machine, and keeps only rows whose machine id is the serving peer's; unit cases added (including an empty local ledger and a forged `/etc/hosts` row). Artifact section 7 corrected.
2. (minor) The whole ledger was read for every outbound message on a development agent. Fixed: read only when the text carries a reference; the re-read skips files over 2 MB.
3. (minor) A thrown error reached the judge as "no reference". Fixed: `records-unavailable` per reference.
4. (minor) A non-advancing peer cursor re-fetched pages. Fixed: stop when the cursor does not advance.
5. (minor) The Work Board fallback wording named only the constitution check when B26 fired. Fixed: chosen by which rules fired.

Confirmed fine by the reviewer: all blocking authority is the LLM verdict; B26 renders only where the standard is on and never for health alerts; B25's text is byte-identical with the shared definition filled in and its Work Board prompt is unchanged when the standard is off; the line match survives platform emphasis; the publish script wording. `designStandardEnabled` is `resolveDevAgentGate(undefined, config)`.

## Evidence pointers

- Unit: `tests/unit/designApprovalEvidence.test.ts` (reference scan, line match through emphasis, stale line, unknown reference, unreadable ledger, edited and deleted file, peer row never opened, peer cache union and cleaning, B26 registration and disposition, rendering only with evidence, Work Board both rules), `tests/unit/spec-approval-constitution-check.test.ts` (B25 unchanged): 41/41.
- Unit: `tests/unit/spec-review-publish.test.ts` (the "Review record for the full design" wording and the constitution line).
- Live proof through the real Telegram path (2026-11-17, M5, throwaway agent on the branch build, test bot @instar_pr2760_livetest_bot in the test group "Instar test - unread and dashboard", topic 118; each message sent by a session bound to the topic through `telegram-reply.sh`, judged by the real outbound gate):
  - approval request with no reference: held by B26;
  - request with a typed, made-up reference: held by B26 (unknown reference);
  - request carrying the real line: delivered;
  - the real line wrapped in bold and italics with extra spaces: delivered;
  - a draft shared without asking for approval: delivered;
  - the plan edited after review, request still carrying the old line: held by B26 (changed since review);
  - one driver run on the edited plan, request with the new line: delivered;
  - Work Board card asking approval with no line: 422 `design-approval-unreviewed` listing B25 and B26; the same card with the current line and the recorded check result: 201.
- Not proven live in this stage: Slack (no Slack adapter on this throwaway; the gate path is channel-independent and the line match ignores Slack's emphasis marks, unit-tested), a request sent from a second machine, and the publish script end to end (this throwaway has no tunnel for the rendered link; its message composition is unit-tested).


## Class-Closure Declaration (display-only mirror)

- **unbounded-self-action — closure: n/a.** Not a self-triggered loop: the peer-row refresh starts only when a read needs it, at most once per 60 seconds, with a single refresh in flight, the same shape as the constitution-check peer cache; it never retries in a loop and never waits in the send path. The machine-readable declaration is in this commit's trace.
