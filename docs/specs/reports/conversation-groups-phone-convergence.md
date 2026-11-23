# Convergence Report — Conversation groups from the phone

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on every one of the 6 rounds (the spec body changed each round, so no round was delta-skipped). Gemini was not authed on this machine (`gemini-not-authed`). The Anthropic clean-door reviewer was available but not used; it is disclosure only and never counts as cross-model.

## ELI10 Overview

The agent suggests groups of conversations ("these chats are all about the shop launch"). Until now only the dashboard could accept those suggestions, and it did so by running every step itself from the browser page. This change moves Accept onto the server as one step that both the dashboard and the phone call, and adds a "make this group a project" flow the owner confirms with Face ID on their phone.

What changes for people: the phone app can be built against these routes (its screens come in an app update), accepting from two places never makes two groups, and a project is only ever created by the owner's Face ID tap after the agent re-checks that the group still matches and that the conversation is not already a project.

The main tradeoff: making sure "is this already a project?" is answered from the agent's complete history pushed the change one layer down into how the Chief of Staff reads its own journal. That read is now complete (all files, all machines' copies) and refuses rather than guesses; a separate pre-existing problem in the Chief of Staff's ordinary read was found and reported.

## Original vs Converged

- **Duplicate groups across machines.** Originally each machine invented its own request numbers, so Accepting the same suggestion on two machines made two groups. Converged: every request number is worked out from the suggestion (the same formula PR #3345 uses), so the pipeline's shared memory of requests makes one group.
- **Stored project drafts.** Originally drafts sat in a file on one machine, and a confirm reaching another machine failed. Converged: the draft carries its own fingerprint and travels with the phone; any machine verifies it.
- **Conversation text as the goal.** Originally the drafted goal copied what the conversations were about (text other people may have written) and pre-filled repositories from it. Converged: the goal comes from the group's name or the owner's own words; conversation text is shown beside the draft only.
- **Stale drafts.** Originally a confirm checked only the fingerprint. Converged: it re-checks the group (exists, same name, still holds the conversation) and the bound projects at the moment of the tap.
- **"Already a project?" read.** Originally a read that silently returned "none" when the history could not be read. Converged: a complete read of every journal file and every peer copy, refusing on any doubt, decided only on the machine in charge, refused before Face ID is spent.
- **Stuck states.** Originally a missing group read closed the suggestion, a refused name stopped the Accept forever, and waits could go on without end. Converged: only the pipeline's own "erased" record closes a suggestion; a refused name or front door is skipped; unexpected answers and missing reads hand the decision back to the owner; five minutes without progress says so plainly with progress kept; the dashboard and phone follow an explicit `next` field.

## Iteration Summary

| Iteration | Reviewers who flagged (design) | Design findings (raw) | Left behind | Spec changes |
|-----------|--------------------------------|-----------------------|-------------|--------------|
| 1 | codex, security, scalability, adversarial, integration, decision-completeness, lessons | 32 | 14 | Required sections added; derived ids; self-certifying drafts; title-only goal; stale-draft re-check; budget enforced; Reject guard; posture markers |
| 2 | codex, security, scalability, adversarial, integration, decision-completeness, lessons | 27 | 12 | Whole-binding repeat check; lease-holder confirm; fail-closed projects read; hidden-character cleaning; membership via parent; legacy routes restored as compat; in-flight submit join; migrating-to-unified marker |
| 3 | codex, security, scalability, adversarial, integration, decision-completeness, lessons | 19 | 10 | Refuse before Face ID; title cleaned; wider character set; refused-create hand-back; unseen group waits; front door kept; truncated-read awareness |
| 4 | codex, security, scalability, adversarial, integration, lessons | 16 | 9 | Complete journal read (archives + current) wired into the running loop; erased-only closure; best-effort name/front door; no-progress brake; catch path bounded |
| 5 | codex, security, scalability, adversarial, integration, decision-completeness, lessons | 19 | 8 | Peer copies must read in full; own directory read and rotation race; cross-machine project precheck; brake counts only time while calls arrive; dashboard Reject follows the hand-back; app half tracked (CMT-1926) |
| 6 | codex, security, scalability, adversarial, integration, lessons | 12 (all resolved in code this round) | 7 | Step-0 status branching; owner re-checks on every re-read; explicit `next` field; miss counter reset; journal flushed before the complete read; peers directory errors refuse; honest app-pending wording |

Standards-Conformance Gate per round: round 1 unavailable (server restarting; connection reset); round 2 ran (5 flags); round 3 ran (7 flags); rounds 4-6 not re-run (the flags it raised were folded into the spec; the gate is signal-only).

Internal reviewers ran on the authoring session's model (Opus 5.5) every round.

## Proportion

Tier 2; about 20 files and roughly 1,600 lines including tests; 6 of 6 rounds used. ⚠ The rounds grew the change one layer down (the Chief of Staff journal read) because the new confirm was the first irreversible decision made from that read; the count of raw design findings fell from 32 to 12, and every round-6 finding was resolved in code.

## Left behind

Accepted with reasons (not safety blockers this change introduces):
- **Cross-machine replication window for bindings.** A binding written on another machine (dashboard PIN route, or a previous lease holder) that has not reached the lease holder is unknowable there; `bindProject` is a last-writer put. Inherent to the existing binding record; the dashboard PIN route has the same window with no check; this change narrows it. Stated in spec §4 for the operator.
- **Chief of Staff loop's own tail read** (newest 1 MB / 10,000 entries) will drop older bindings from the loop's views. Pre-existing, outside this change; reported as feedback fb-b58eee8c-aee. Also: the memo comment names CMT-1415 for compaction, which is a different commitment.
- **Accept progress cache-loss exception.** A member the owner moves out during their own unfinished Accept can be moved back by a resume elsewhere; goes away with CMT-1650.
- **Per-read graph rebuild cost** (bounded per call); **peer streams read twice with no total cap** (fine at current machine counts); **step-0 wait does not reach the 5-minute brake** (each call bounded; rare); **a member that reads 404 is skipped** (the owner can move it by hand); **whitespace-only peer replica file reads as incomplete** (fails closed).
- **64 MB complete-read cap** about two years out at today's growth; refuses (never binds) and reports a degradation; compaction is part of fb-b58eee8c-aee.
- **Compat routes** `/start` and `/accepted` kept one release.
- **Dashboard PIN bind route** outside the lease check: pre-existing, unchanged.
- Precision items (wording, extra rows) were fixed in passing where one line; the rest are in the findings catalog.

## Full Findings Catalog

Round-by-round findings were recorded by each reviewer (security, scalability, adversarial, integration/deployment, decision-completeness, lessons-aware, and codex `gpt-6-astra`) and resolved as listed in the Iteration Summary. Highest-severity items and resolutions:

- R1 integration/adversarial (high): two machines make two groups → derived request ids.
- R1 decision-completeness (high): required sections missing → added with classifications and fixed-limit bases.
- R1 security/lessons (med): conversation text becomes an owner-confirmed goal → title-only goal, context display-only.
- R1 codex/adversarial/lessons (med): stale drafts → live re-check at confirm.
- R2 lessons (high): projects read silently empty when unreadable → fail-closed read.
- R2 codex/adversarial/lessons (med): goal-only repeat detection → whole-binding comparison.
- R2 security/adversarial/lessons (med): lagging machine overwrites a binding → lease-holder-only confirms.
- R3 lessons (high): tail read drops older bindings → complete read; foundation bug reported.
- R3 security/lessons (med): unclean group title makes drafts unconfirmable → cleaned title.
- R3 security/adversarial/integration/lessons (med): lease checked after Face ID → refused at challenge time.
- R4 integration/scalability/lessons/security (high): fail-closed read not wired into the running loop and would refuse once the journal passed 1 MB → complete archive+current read wired into both journal objects.
- R4 adversarial (high): partial graph read closes a suggestion → only the pipeline's `erased` record closes.
- R5 security/adversarial/integration (med): peer copies read without completeness → peers must read in full; remaining lag window stated.
- R5 adversarial/lessons (med): dashboard disables Reject after hand-back → `next`-driven card.
- R5 codex (med): cross-machine project precheck misread as placed elsewhere → derived create status check.
- R6 codex/security/adversarial/lessons (med): step-0 non-committed answers closed the suggestion → only certain answers close; 403 → not-owner; unanswered → wait.
- R6 integration (med): own queued binding not yet on disk → journal flushed before the complete read.
- R6 adversarial (med): unreadable peers directory read as "no peers" → own directory read, ENOENT only.

## Convergence verdict

Converged at the Tier 2 cap (round 6). Raw design findings fell 32 → 27 → 19 → 16 → 19 → 12; every round-6 design finding was resolved in code with tests in the same round, and what remains is listed in Left behind as accepted, none of them a safety, security or data-loss risk that this change introduces (the cross-machine binding window is pre-existing and narrowed here, and is stated for the operator). Open questions: none. Spec is ready for approval under the standing rule.
