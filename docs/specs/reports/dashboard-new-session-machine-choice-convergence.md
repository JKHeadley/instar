# Convergence Report — Dashboard New Session: choose the machine

Spec: `docs/specs/dashboard-new-session-machine-choice.md` · ELI16: `docs/specs/dashboard-new-session-machine-choice.eli16.md`
Requested by Justin (Telegram topic 112490, 2026-10-18 19:13 PDT): "this feature should also allow selecting what machine the new session will be running on."

## Cross-model review: codex-cli:gpt-6-astra (RAN, rounds 2–9) + clean-door claude-code:claude-fable-5 (RAN, rounds 1–9)

Round 1's Codex pass was `degraded` (the agent-home build resolved the retired gpt-5.5); from round 2 the script ran from the worktree build and resolved gpt-6-astra every round. The clean-door Anthropic reviewer ran every round. Both were fed the spec plus the parent door/model spec, the session-pool spec, the topic-profile spec and the durable-inbound-queue spec (the last two were truncated by the prompt budget in most rounds; both reviewers said so).

## ELI10 Overview

The dashboard's New Session box gets a Machine dropdown. Automatic keeps today's behaviour. Picking this machine starts here and pins the topic here. Picking another machine asks that machine first (over the same signed link the start will use, and over HTTP for the door and model), creates the topic, places ownership on it, sends it ONE checked start command carrying the door and model, and settles ownership by what came back: accepted or no answer ⇒ it owns the topic and is pinned; refused ⇒ released and NOT pinned; lost an ownership race ⇒ the other placement stands and the box says so. Offline, out-of-step, not-updated, credential-mismatched or unreachable machines are refused before anything is created. A topic is never quietly started somewhere else.

## Original vs Converged

| | Original draft (round 0) | Converged (round 9) |
|---|---|---|
| When the session starts | On the topic's first message (pin-only) | Immediately, on the target, by a checked `deliverMessage` |
| Where the door/model is validated | On the creating machine | On the target, in a pre-flight before anything is created |
| How the start travels | `SessionRouter.route()` (queue + fire-and-forget) | A dedicated seam beside the router: place → checked deliver → settle; never the inbound queue |
| Outcome model | Success / failure | Tri-state from ONE acknowledgement table: accepted / rejected / unknown, plus superseded |
| Unknown outcome | Release ownership | Keep ownership (a possibly-live session is never denied its record) |
| Refused start | Pinned anyway | Released and unpinned (a refusing machine is never pinned) |
| Lost claim | Assert `active@target` | Fenced by placement epoch; another generation is reported, never asserted over |
| Pre-flight plane | Bearer HTTP only | Signed mesh probe (`session-status`) + Bearer HTTP, with a named refusal for a token mismatch |
| Topic line | "This topic runs on X" | "This topic is assigned to X; its session is starting there. Requested: …" (unknown variant says no confirmation came back) |
| Owner-side receipt | Marked injected before the start ran | Marked injected only after seed + spawn ran; crash-before-seed gap named and tracked (ACT-127) |
| Forwarded message during a start | Second spawn | Bounded wait (60 s, capped at 32 waiters), then inject or the inbound error path |

## Iteration Summary

| Round | Reviewers who flagged | DESIGN-class findings | Spec / build changes |
|---|---|---|---|
| 1 | internal (security, adversarial, integration, lessons), clean-door Claude | Pin-only breaks profile transfer; partial-failure sequencing unspecified; offline check deferred to first message | Immediate start on the target; failure table; offline refusal is create-time with no confirm path. Standards-Conformance Gate: ran (output not retained; the early rounds' flags were re-raised and recorded from round 3). Codex: degraded (gpt-5.5 retired on the agent-home build). |
| 2 | Codex, clean-door Claude, internal | Door/model validated against the wrong machine (holder, not target); route-throw loses the choice; failure table omits the create step | Target pre-flight (`POST /topic-profile/validate-choice`) and `GET /topic-profile/options?machine=`; failure table rows. Standards-Conformance Gate: ran (output not retained). |
| 3 | Codex, clean-door Claude | A failed ack does not prove the target did nothing; validation authority contradictory between §3.2 and step 0; the "runs on" line can lie; the 60 s wait has no exhaustion outcome | Tri-state deliver outcome; unknown keeps ownership; the direct seam replaces `SessionRouter.route()`; wait exhaustion → inbound error path. Standards-Conformance Gate: ran (2 flags). |
| 4 | Codex, clean-door Claude; internal quiet | Pin retention contradicts the order of steps; settlement CAS failures unspecified; placement presented as execution; one code for two causes | Checked settlement with one claim retry; pin via a callback after the claim; `reason` on `machine-choice-unavailable`; "assigned", not "runs on". Standards-Conformance Gate: ran (3 flags). |
| 5 | Codex, clean-door Claude; internal quiet | Unprotected window between release and pin; settlement failures vs the response contract; control command with a live session undefined; ack semantics split across two steps; silent default-door start | Pin before any release; ONE acknowledgement table (`classifyDeliverReply`); owner branch independent of session existence; null-context correction line; receipt marked after the start ran. Standards-Conformance Gate: ran (1 flag). |
| 6 | Codex, clean-door Claude; internal quiet | Pinning a machine that definitively refused; pin ordering vs the numbered steps; receipt ≠ execution (crash before seed); fleet-wide wait buried | No pin on a refused start; steps renumbered 3a–3e with an outcome table; receipt sentence qualified by the queue being live; crash-before-seed named; unbound-session correction; two decision-point rows. Standards-Conformance Gate: ran (1 flag). |
| 7 | Codex, clean-door Claude; internal quiet | Auth contract contradicted the pool spec (per-install tokens); a lost claim could assert over another owner; clock policy stricter than placement; two planes for one lifecycle | Honest Bearer-plane statement + `peer-auth` refusal; supersession (another owner) reported, never asserted; clock threshold = placement's; waiter cap (32); Maturation plan; creator-performs-claim and intent-header sentences. Standards-Conformance Gate: ran (4 flags). |
| 8 | Codex, clean-door Claude; internal quiet | Settlement identified by machine, not placement generation (a late rejection could release a newer placement on the same target); dashboard silent on 202 superseded/not-confirmed; mesh plane never probed before pinning | Epoch-fenced settlement (only `placing@E` / `active@E+1` is this placement); signed `session-status` probe in step 0 with `reason: 'mesh'`; dashboard reads `ownership` first; `start-not-wired` made reachable; ACT-127 opened for the crash-before-seed replay; live drive named as the first integrated proof. Standards-Conformance Gate: ran (4 flags). |
| 9 | Codex (SERIOUS: three repeats — pool invariant wording, generation window after a successful claim, two-registry harness), clean-door Claude (MINOR: inherit the L4 retry, mesh validate command, 502 class, readability); internal quiet | none that changed the design | Bounded same-id retry of a THROWN deliver (Frontloaded Decision 11); the claim→pin crash window stated honestly (an unpinned owned topic is the ordinary router-placed state); status-class note and Decisions 12–13 recorded. Standards-Conformance Gate: ran (3 flags — the receipt/crash gap tracked as ACT-127, the forwarded-wait loss notice when the queue is dark, both already named in the spec). |

Internal reviewers (one general-purpose subagent per round reading spec AND code, plus the round-1 panel) raised DESIGN-class findings in rounds 1–3 and were DESIGN-quiet from round 4; each later round's internal pass verified the previous round's changes landed in code and reported only PRECISION items, all folded in.

## Standards-Conformance Gate — flags that persisted, and the answer recorded in the spec

- **Ownership-Gated Side Effects** (every round from 3): the creator posts the "assigned to" line after ownership moved to the target. Deliberate and justified in Multi-machine posture: the line describes the placement the router (the conversation's placement authority) just made, and the target's own deterministic sends can sit held by origin egress; the target posts only corrections.
- **Accepted Intake Must Drain / No Manual Work / No Deferrals** (rounds 7–8): a target crash after the receipt but before the seed leaves the requested door unapplied. Named as the known gap in step 4, reported through the durable inbound queue where live, and tracked as evolution action ACT-127 (due 2026-11-02) instead of left as prose.
- **Bounded Blast Radius** (round 7): one detached waiter per forwarded message — closed in round 7 by the machine-wide cap of 32.
- **Verify the State, Not Its Symbol** (round 4): the line said "runs on" after an unknown outcome — closed in round 4 ("assigned", with the unknown variant).
- **The Agent Carries the Loop** (round 6): a refused start needed the operator to act — closed in round 6 (a refused start leaves the topic for ordinary placement; the only operator action left is a re-pick, named in the response).

## Findings declined, with reasons

- **A two-registry deterministic harness with delayed journal propagation** (Codex, rounds 6–8). The unit tests script every registry/delivery ordering the fence must handle (lost claim, moved record, newer placement on the same target, throw mid-deliver); journal propagation is the parent's tested path; the e2e proves the live wiring; the live drive is the first integrated traversal and the graduation criterion measures it for a week. Building a split-registry harness would re-test the parent, not this feature.
- **Collapse `superseded` and `not-confirmed` into one dashboard presentation** (Claude, round 8). Done for the dashboard (both show the server's sentence as one warning); the API keeps the two codes because their recoveries differ.
- **A self pick with pin replication dark should start locally with a notice** (Claude, round 8). Kept conservative: a machine pick whose pin cannot be replicated is the "quietly load-balanced away later" failure the operator ruled out; Automatic is one tap away.
- **Readability: fewer rebuttal parentheticals** (Claude, rounds 6–8). The step-3 outcome table was added in round 6; the prose is left as the provenance of the decisions.

## Convergence verdict

Converged after round 9. The round-8 findings were the last to change the design; round 9 produced one bounded behaviour refinement (the retry) and wording, and every other round-9 item was a repeat already answered in the spec. Justin's convergence standard (2026-08-19) — stop when findings stop changing the build, not after a fixed count of clean rounds — and the skill's DESIGN-class rule were both applied: the internal reviewer was DESIGN-quiet from round 4, and the externals' remaining items in round 9 did not change the build.

Decision-Completeness: 10 Frontloaded Decisions, 0 cheap-to-change-after tags, 0 contested tags.
