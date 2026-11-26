# Convergence Report — Telegram topic names reach every machine

**Spec:** [docs/specs/topic-name-replication.md](../topic-name-replication.md)
**Slug:** `topic-name-replication`
**Converged at:** 2026-11-21 (round 6, the Tier 2 cap)
**Iterations:** 6
**Final-round design findings:** 0 open in the build (the internal round-6 design finding was a spec sentence that lagged the code, fixed in place; the external round-6 findings are fixed or left behind below)

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI in every one of the six rounds (status `ok` each time). Gemini was not available (`gemini-not-authed`). The Anthropic clean-door family was available but not run. The external reviewer's verdict stayed "SERIOUS ISSUES" through round 6 because each round it found further long-tail ordering cases; every finding that changed the build was fixed, and the rest are listed under Left behind with a reason.

Standards-Conformance Gate: unavailable in all six rounds — the agent server on port 4042 was listening but not accepting connections for the whole session (`curl` connect timeout), and restarting it was out of scope for this run. The constitutional pass was therefore carried by the lessons-aware reviewer each round.

## ELI10 Overview

The agent runs on several computers, but only one of them (the lead) listens to Telegram, so only the lead learned what each conversation topic is called and when it was renamed. When the lead died in the 19-20 November outage, 13 project topics lost their names on every other computer and had to be typed back in by hand.

This change makes every name and rename travel to every computer through the record-copying system the agent already has. Each computer puts the name into its own list and saves it. Every computer that accepts a new name also keeps its own copy in its journal, so a rebuilt computer can learn all the names from any survivor even after the lead is gone.

The main tradeoff is ordering. Names arrive from different places at different times (a rename, a late rename notice, a message quoting the topic's original name, names held before this shipped). The design gives each kind of evidence a rank and each row a time from a clock that can be compared with Telegram's, so an older name never replaces a newer one. A name held from before only fills a blank. What it deliberately does not do: it never deletes names, it never changes anything in Telegram, and it does not try to settle the rare case of an agent rename and an owner rename in the same second.

## Original vs Converged

- **Originally**, every name a machine learned from Telegram was published as an "observed" change that beat what other machines held. **After review**, only real renames (an API rename, or Telegram's rename notice) count as renames; a creation name, a reply that quotes the creation message, and names held before the upgrade only fill blanks. **Why:** the reply-to-creation path would have published a topic's original name as a fresh change after a rebuild and undone real renames everywhere, the very outage this fixes.
- **Originally**, retries happened only at the next restart. **After review**, an in-process drain sends refused rows in batches under the journal's rate cap, quickly while it is making progress and backing off to hourly when it is not. **Why:** a backfill of ~400 names hits the journal's per-kind rate cap, and a server can run for weeks.
- **Originally**, the first machine to upgrade would decide every shared "from before" name. **After review**, the machine that is the Telegram lead at its first boot with the change shares its own names with a higher rank (`lead`), once per machine. **Why:** standbys never saw renames, so their old names are often stale.
- **Originally**, stamps used the hybrid logical clock. **After review**, local rows use the wall clock and rename notices use Telegram's own time (end of its second) and message id. **Why:** the logical clock can run ahead by a peer's skew and would let an agent's rename beat a later owner rename.
- **Originally**, session binds and replicated names fought over the map. **After review**, a bind keeps the replicated name, a crash between the store's and the registry's writes is repaired at boot, rows are scoped to the Telegram group, far-future rows wait in memory instead of winning forever, and the rename label follows on standbys too.

## Experience fit

- **Goal and source:** the owner approved the post-mortem fix program (topic 145840, message 145918); ledger item N40 states the outcome: names and renames correct on every machine within minutes, surviving the lead's death, with no hand repair.
- **Ordinary journey:** the owner renames a topic in Telegram; the lead captures the rename notice, publishes a row, peers pull it within the journal-sync cadence, apply it to their map and registry, and carry it. Verified by the integration test (rename on A reaches B, B carries, rebuilt C learns it from B with A gone).
- **Contrasting cases checked:** late rename notices, out-of-order same-text renames, a reply quoting the creation name, a standby upgrading first with stale names, the lead role moving, a group replacement, a broken peer clock, a refused journal write, a crash between writes.
- **Evidence limits:** no live multi-machine drill was run in this session (the agent server was not accepting connections); the evidence is unit, integration (three real journals) and e2e (production wiring) tests.
- **Disposition:** delivers the goal on the ordinary path; the remaining gaps (a name learned by a lead that dies before any peer pulls, sub-second agent/owner rename races) are documented residual risks.
- **Trust/approval surfaces:** not applicable — the feature asks no one for anything and gates nothing.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security/adversarial, scalability/integration, decision/lessons, codex | 12 (deduplicated: 9) | 9 | Design §1-§9 rewritten; posture, decisions, limits, residual risks, tests |
| 2 | sec/adv/scale/integ, decision/lessons, codex | 9 | 10 | §2 deferral, §3 same-text renames, §4 lead re-fill, §5 write order, chat field, posture |
| 3 | all-lenses, codex | 7 | 5 | `lead` rank, `seq`, wall clock, final refusals, chat-scoped `filled` |
| 4 | all-lenses, codex | 5 | 3 | total-order comparator, once-per-machine lead decision, provenance |
| 5 | codex (internal round: 0 design) | 5 (codex) | 4 | lead promotes same-text fill, deferral by event id, registry-write failure doc |
| 6 | codex (internal round: 1, a lagging sentence) | 3 open, 1 fixed | 4 | snapshot own names before landing; doc fixes |

Standards-Conformance Gate, per round: rounds 1-6 `unavailable: agent server on :4042 not accepting connections`.

## Proportion

Tier 2 (multi-machine state, new replicated kind). About 13 source files touched plus 3 test files, roughly 700 added lines; spec 221 lines. Six rounds used of a cap of six — in line for a Tier 2 multi-machine change, though the external reviewer kept finding long-tail ordering cases each round.

## Left behind

Design findings accepted at the cap (none concerns safety, security or data loss; each affects only which display name a topic shows, and the next rename corrects it):

- Round 6 (codex): the boot reconcile re-applies a fill recorded in `filled` even if a session bind changed the name while the kill switch was off. Needs the switch toggled off and on with a bind in between; the next rename corrects it.
- Round 6 (codex): if more than 1000 far-future rows arrive (only possible from a peer clock more than 5 minutes ahead), the farthest are dropped from memory and land at the next boot instead of by timer.
- Round 5/3 (codex): an agent API rename and an owner rename within about a second of each other may resolve either way; documented as a residual risk (Telegram exposes no shared ordered version for topic edits).

Precision items not iterated on:

- The registry file is not group-scoped (pre-existing); documented as a residual risk.
- `defer()` sorts on insert past the bound; negligible at 1000 rows.
- The attention-item path writes `item.title` into the lead's map outside the hook (pre-existing, cosmetic).
- Whether Telegram sends the bot a notice for its own `editForumTopic` is not relied on; if it does, a duplicate same-name rename row results.
- The census row in the parent spec must list this kind; routed to the run lead of topic 145840 (see the spec's handoff section).

## Full Findings Catalog

**Round 1.** Security/adversarial: A1 reply-to-creation published as an observed rename (DESIGN, fixed: fill rank); S1 names are not only display strings (DESIGN, fixed: authority restated, control/bidi characters rejected); A2 extreme `atMs` wins forever (DESIGN, fixed: drift bound); A4 rate cap vs backfill (DESIGN, fixed: batches + drain); A5 carry design sound (INFO). Scalability/integration: S1 rate cap (dup), S2 per-row full-file writes (DESIGN, fixed: one write per batch), S3 names captured before wiring (DESIGN, fixed: wire before `start()`), I1 rename handler missing on send-only branch (DESIGN, fixed), I2 creation name (dup), I3 missing registrations (DESIGN, fixed), I4-I6 precision (posture wording, `result.name`, awareness entry — all done). Decision/lessons: F1 (dup of A1), F2 session bind overwrote replicated names (DESIGN, fixed: authority), F3-F6 precision (census route, upgrade burst sized, lead-dies window documented, `result.name`). Codex: creation evidence undoes renames (dup), registry/outbox crash ordering (DESIGN, fixed), backfill arrival-order dependence (DESIGN, fixed: `filled`), refusal stranded until reboot (dup).

**Round 2.** Internal: D1 `heldName` returned an unapplied fill (DESIGN, fixed), D2 mixed clocks (DESIGN, documented + end-of-second stamps), D3 rows not chat-scoped (DESIGN, fixed: `chat`), D4 posture wording (fixed). Decision/lessons: N1 first-upgraded standby decides fills (DESIGN, fixed: lead re-fill), N2 = D1, N3 progress cadence (fixed: 5 s), N4 census tracking (routed), N5 owner rename seconds after agent rename (documented), N6 permanent refusals retried forever (fixed: final), N7 `lessons-engaged` (added). Codex: same-text rename A,B,A (DESIGN, fixed), mixed clock authority (documented), `heldName` (dup), `filled` crash window (DESIGN, fixed: write order + replay rule), future rows only at boot (DESIGN, fixed: timer).

**Round 3.** Internal: D1 HLC skew in stamps (DESIGN, fixed: wall clock), D2 lead re-fill every boot (DESIGN, fixed: once), P1-P5 precision (creation stamps, handler on put-back, tunables relabelled, final flag, self-edit assumption — done). Codex: lead precedence order-dependent (DESIGN, fixed: `lead` rank), same-second notices (DESIGN, fixed: `seq`), group replacement republishes names (DESIGN, fixed in part: chat-scoped `filled`; registry documented), persistence failure (DESIGN, fixed: registry only after state write), final refusal re-tried after restart (DESIGN, fixed: persisted final).

**Round 4.** Internal: D1 lead decision repeats on a later lead (DESIGN, fixed: once per machine, any role), P1-P2 wording (fixed). Codex: non-transitive comparator (DESIGN, fixed: one lexicographic key), lead change promotes stale name (DESIGN, fixed), final refusal not persisted on finals-only tick (DESIGN, fixed), same-name fill cleared provenance (DESIGN, fixed), adapter test wording (precision).

**Round 5.** Internal: converged, 0 DESIGN, 4 PRECISION (wording, header, two-leads residual, name tiebreak — all done). Codex: lead skipped same-text fill (DESIGN, fixed), competing lead snapshots (documented), A,B,A through the adapter (test added), deferral evicts sooner rows (DESIGN, fixed: by event id), registry write failure retry (documented: the adapter's next write carries it).

**Round 6.** Internal: F1 spec sentence lagged the code (fixed), F2 borrowed names gain lead rank (fixed: own-name snapshot before landing), F3 far-ahead clock revert (documented), F4-F5 precision (done/none). Codex: borrowed names (fixed), reconcile after kill-switch toggle (left behind), deferred overflow (left behind), adapter test (already covered by the A,B,A adapter test), competing leads wording (clarified).

## Convergence verdict

Converged at round 6 (the Tier 2 cap). The final internal round found nothing that changes what gets built once its one lagging sentence was fixed; the remaining external design findings are long-tail ordering cases on a display name, accepted under Left behind with reasons. Spec is ready to approve and build.
