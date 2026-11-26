# Convergence Report — Native Plans, What I've learned about you, and Other agents screens (read-only)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on every round (6 of 6, each on a changed spec body). Gemini was not authed on this machine (`gemini-not-authed`), so it did not run.

## ELI10 Overview

The Instar iPhone app is getting three more screens that used to need the web dashboard. **Plans** shows the agent's longer projects and multi-step efforts: what is waiting for your OK, what is moving, what has gone quiet, and what is finished. **What I've learned about you** shows the habits the agent picked up from being corrected, and the corrections it is still watching. **Other agents** shows the agents it talks to (paired or not, answering or not) and which ways of reaching people and agents work on this machine.

The screens only look. Nothing on them changes a plan, a preference or a pairing. Only the owner's phone can open them. Each answer is a short summary built from a fixed list of fields, so internal ids, file paths, agent fingerprints, invite codes, message bodies and raw error text never reach the phone. Plans and corrections are gathered from every machine that answers, and a machine that doesn't answer or is offline is named, so a partial list never looks complete.

The tradeoff is a little extra traffic between the agent's own machines, capped at one read every 15 seconds per screen, and a few list limits (200 plans, 40 corrections, 100 agents) that the screens say out loud when they apply.

## Original vs Converged

- **Plans from different machines.** At first, a plan with the same id on two machines was merged into one row. Plan ids are names people choose, so two different plans could share one, and one could hide the other. Now each plan belongs to its machine, and two machines' plans are never merged. Corrections do merge, because their ids include the machine.
- **Future dates.** A peer could have made its copy of a record win by stamping it in the future. Now a time more than 5 minutes ahead counts as no time.
- **Missing machines.** Offline machines were invisible at first. Now they are counted and named, and the headline says it covers "the machines that answered".
- **"Switched off" versus "broken".** Only a peer's documented "switched off" answer counts as off. Any other error counts as not answering.
- **Text cleaning.** One cleaner now handles all shown text: it removes control and bidi characters, scrubs secrets, and limits length.
- **Pairing across machines.** The order is defined. Blocked on any machine shows as blocked. A pairing held only by another machine reads "paired elsewhere". Plans with an unknown status stay listed instead of disappearing.
- **Peer reads are bounded.** An oversized peer answer is not parsed, and the row limits are written down as decisions rather than left as tunable settings.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security/adversarial, integration/scalability, decision-completeness/lessons, codex | 9 | 8 | merge rule, offline coverage, selfState shapes, body cap, one cleaner, caps decided, 503 rule |
| 2 | codex (internal: 0 design) | 2 | 4 | pairing merge order, unknown statuses kept, schema enums |
| 3 | codex | 2 | 1 | plan identity (id + title), enums declared |
| 4 | codex | 3 | 0 | plans per machine, unique row keys, documented 503 bodies |
| 5 | codex | 2 | 1 | remote pairing reads "paired elsewhere", structured-field redaction contract, null dates |
| 6 | codex (internal: 0 design) | 2 | 4 | corrections "off" needs every machine known off; overflow note names each machine's console |

Standards-Conformance Gate: ran in round 1 (3 flags: multi-machine posture, maturation path, live-user-channel proof; all three engaged in the spec: proxied-on-read posture with offline/unread coverage, the mobilePairing ladder, and the dev-agent-live check tracked after release). Later rounds: not re-run, because the flagged standards' sections did not change their posture.

Internal reviewer model: Opus 5.5 subagents, all rounds. Round 1 ran the six lenses as three paired reviewers; rounds 2 and 6 ran one reviewer covering every lens and checking the code; rounds 3 to 5 changed only narrow contract points and ran the external pass alone.

## Proportion

Tier 2. About 11 files and about 1,300 added lines including tests. Used 6 of 6 rounds, at the cap. The late rounds settled cross-machine identity and wire-contract details for a read-only summary, not access control. The round-6 design items were fixed in place, without another round, under the cap rule; neither touches safety, security or data loss.

## Left behind

- An agent's row key is an unsalted hash of its public fingerprint, so anyone holding the response can link the two. The fingerprint is public, and the response goes only to the owner.
- `scrubSecrets` misses `sk-ant-…` keys. This is the shared scrubber; filed to the feedback queue as fb-3fd2df1e-059.
- Peer body size is checked in characters after reading. The 5 s timeout bounds the read, and peers are the agent's own machines.
- The console's "includes my other machines" label for preferences is not shown on the phone, because the union path always says `mesh`.
- On the Other agents screen, offline machines are not listed (pairing and delivery merges skip them). Plans and corrections do list them.
- Rounds 3 to 5 had no separate internal reviewer. Each changed only contract details that the round-6 internal reviewer then rechecked against the code.

## Full Findings Catalog

- R1 security: a future-dated peer takeover (fixed: clamp, local wins ties); bearer forwarding to peers (clarified: the existing `poolPeerFetch` transport, no new forwarding); an unbounded peer body (fixed: cap); bidi characters (fixed: one cleaner); row key linkability (left behind); "verified name" wording, cache order and peer-text injection notes (fixed in wording).
- R1 integration: the mesh label is wrong on dev agents (fixed: dropped); extraction edges (stated); the corrections 503 rule (fixed); the plans fan-out could be redundant (checked: no replication path names `initiatives.json`, so the fan-out stays); an unbounded `/initiatives` (cap); the machine-local markers hold; the sibling PR anchor (separate anchors).
- R1 decision-completeness: offline machines invisible (fixed); Decision 9 contested as user-visible (now frontloaded, not tagged cheap); needs-you causes for peers (stated: read from the record); missing verify-the-state lines (added).
- R1 codex: offline coverage, partial-failure shapes, truncation contract (all fixed).
- R2 codex: the pairing merge order (fixed); unknown-status plans dropped (fixed: grouped as open).
- R3 codex: wire enums (declared); cross-machine id identity (plans re-keyed).
- R4 codex: id + title could still hide plans (fixed: per-machine identity); duplicate row keys (fixed); any 503 read as off (fixed: documented bodies only).
- R5 codex: pairing location lost (fixed: remote mutual reads as elsewhere); redaction contract wording (clarified as structured fields); null dates (stated).
- R6 codex: corrections "off" with an offline machine (fixed); overflow destination (fixed note). R6 internal: needs-you for unknown statuses, the "another machine" fallback, a stale comment (all fixed).

## Convergence verdict

Converged at round 6, the Tier-2 cap. The round-6 internal reviewer found nothing that changes the build. The two external design items in round 6 were small display-contract fixes, applied and unit-tested, and neither is about safety, security or data loss. 6 items are left behind. The spec is ready for approval under the operator's request.
