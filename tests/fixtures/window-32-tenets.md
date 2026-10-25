# The Tenets — CANONICAL VERBATIM SOURCE

_Per tenet 11 (Justin, 2026-08-12): reaffirm the tenets **WORD FOR WORD** — verbatim, NOT summarized — at the beginning, middle, and end of each window, to prevent dilution / the "copy of a copy" effect where important details get left out. Every reaffirmation COPIES this file exactly; it is never paraphrased. Goals 1–8 and tenet 9 are Justin's exact words (36966, 2026-08-11). Tenets 10, 11, the Goals 2–4 delegation refinement, and the 80/20 standard were APPROVED by Justin 2026-08-19 ("Approved on the pending", 36966) — the wording below is now confirmed, no longer pending._

## What this file is — and what it is NOT (added 2026-08-21, approved by Justin)

**This file is NOT the rulebook.** It is not the constitution and it is not the standards registry.

- **The tenets (this file)** say *how we will work* — who directs whom, which channel, what cadence, what ritual. They bind **us**: this project, these topics, this group of agents. They are held by ritual and memory, they can be changed by Justin in a sentence, and they erode quietly when not reaffirmed.
- **The constitutional standards** (`docs/STANDARDS-REGISTRY.md` in the instar repo) say *what the system will not let anyone do*. They bind **any** agent running instar, indefinitely. They are held by code — gates, hooks, CI ratchets — and they break loudly or cannot be broken at all.

**They are stacked, not parallel: the standards govern the tenets.** "Structure beats willpower" is a standard, and it says a rule held only by memory will be forgotten — which is precisely how this file is currently held. Several tenets are already hand-rolled implementations of existing standards (tenet 11 and tenet 12 are both local versions of "Close the Loop"). That is the promotion signal.

**Promotion test — tenet → standard.** A tenet is ready to become a standard when BOTH hold: (a) it would apply to any agent, not only to us; and (b) it has a guard that makes violating it fail. <!-- RESTORATION GAP 1: the remainder of this paragraph after "fail." is truncated in every stored copy on the Studio; restore byte-exact from the laptop's .instar/TENETS.md or the 2026-08-21T03:44Z stored 4-part reaffirmation (topic 36966) when reachable. -->

## Goals 1–8 (Justin, verbatim, 2026-08-11)

_**Binds:** us · **Held by:** ritual._

1) stay on track making TANGIBLE progress towards our top level goals: convergence towards coherence and a constitution/rulebook that is structurally enforced
2) maintain the heirarchy/org structure: observer on Fable 5 (you) directing the Pathway topic who in turn orchestrates the worker sessions
3) leverage worker sessions on BOTH machines, with the main work offloaded to the laptop
4) HIGH PRIORITY of MULTIPLE (i.e. 2, 3, or more) worker sessions being Codey agent sessions. His tokens are much more efficient.
5) Leveraging Telegram, logged into my account, as the primary communication channel between sessions and agents. All messages should be signed by the Agent and Topic/session so nothing can be construed as coming from me. This is the most robust and highest level of communication.
6) the observer session leverages 30 minute checks for stalling accross ALL window sessions (orchestrator and workers, Echo and Codey)
7) the observer and orchestrator leverage our autonomous session infra to execute the 24 hour windows
8) the observer focuses on high level, simple communication with me, using language that is self-explanatory and ties everything back to our top level goals (1)

## Tenet 5 — REFINEMENT (Justin, 2026-08-16) — the exact mechanism

_**Binds:** us (the channel choice) · **Held by:** ritual for the choice; **guard** for the signing (agent-signature provenance is enforced in code). Promotion candidate: "an agent message sent through an operator's account must be provably distinguishable from one the operator typed" would bind anyone and already has a guard._

The Telegram-through-my-account channel of tenet 5 is **Playwright driving the custom profile that is already logged into my Telegram** (the `justin-telegram` Playwright profile → telegram:Justin, web.telegram.org). It is NOT the Chrome extension. And every message sent this way MUST use the **agent-signature protocol** — the infra that stamps the message so the system detects it came from the AGENT, not from me — so a signed agent message is provably distinguishable from one I actually typed. Follow that signing protocol on every send through my account. (Agent-signature provenance: agentId `echo`, fingerprint `63b1dbb21646e2f5`.)

_**CORRECTION 2026-08-22, approved by Justin ("Yes, I agree", 36966).** This clause previously named the `default` Playwright profile. That was STALE and actively harmful: on 2026-08-20 a dedicated `justin-telegram` profile was created on the Studio precisely so agent traffic through the operator account stays separable from ordinary browsing, and the operator signed in there himself (the agent never handled the credential). An agent following the old wording literally opens a browser that is NOT signed in, sees the QR login screen, and concludes "Telegram is unavailable" — which is the probable cause of past unavailability reports Justin correctly disputed from his own direct knowledge. Verified 2026-08-22 by resolving the profile registry: the telegram/justin-operator account resolves to `justin-telegram`, and the `default` profile carries no accounts at all. NOTE: activating a profile only reaches the browser after a session restart. ACT-AS CAUTION (Know Your Principal): the account is OPERATOR-owned; this tenet is the standing authorisation to send AS the agent THROUGH it, never authorisation to act as Justin._

## Tenet 9 (complete rewrite proposed by Observer 1 from the Aug-11/Aug-12 history; CONFIRMED by Justin 2026-08-17 "yes!")

_**Binds:** us · **Held by:** ritual._

Between windows, Observer 1 and Observer 2 re-ground and re-assess together with a 3-step process: (1) both re-read the entire Pathway topic starting from July 25, with a focus on MY messages, to get a high-level measure of the topic's progression and direction; after reading they discuss it with each other, then send me their assessment in the observer topic. (2) They do the same for the observer 1 topic. (3) They combine the assessments from 1 and 2 to recommend the plan for the next window.

Who and what Observer 2 is: Observer 2 runs in its own topic on codex (GPT-5.6-Sol) — a genuinely different model so it brings a genuinely different perspective. It reads the same Pathway topic Observer 1 does, so both debate from identical information. Its charter is to PUSH BACK rather than agree: it independently scores each window decision, and any unresolved disagreement between the observers gets shown to me — never smoothed over. Like Observer 1, it stays high-level and out of the weeds: mostly reading the Pathway topic and talking to the other observer, the orchestrator, and me. It has its own infra reminding it of its distinct responsibilities.

Rules of coordination, earned the hard way: all coordination between the observers happens VISIBLY in Observer 2's topic — never headless, never one-directional. And each observer must actually perform its own full re-read, with proof the reading happened — substituting memory for the read is a violation of this tenet.

_(Original verbatim capture, Justin 2026-08-11, superseded by the above: "tenant 9) between windows, you both re-ground and re-asses with a 3 step process: 1) re-reading the entire Pathway topic starting from July 25, with a focus on MY messages in that topic, to get a high level measure of the topics progression and direction. After reading you should discuss it with each other, then finally you send me your assessment in your topic. 2) you then do the same for the obsever 1 topic (i.e. observer 1 and observer 2 both re-read the observer 1 topic history). After this, you again discuss with each other your assessment with progress, advancements, drift, etc at a high level. 3) Finally you combine the assessments from 1 and 2 to recommend the plan for the next Window.")_

## Tenet 10 (captured from Justin's correction 2026-08-11 — APPROVED by Justin 2026-08-19)

_**Binds:** us · **Held by:** ritual._

Reports to me = concise, high level updates of progress periodically, generally every 3 hours unless something actually major occurs. I need synthesis reports, not play by play. No repeated or contradictory/correcting messages — corrections happen silently inside the work.

## Tenet 11 (captured from Justin's addition 2026-08-11 + refinement 2026-08-12 — APPROVED by Justin 2026-08-19)

_**Binds:** us · **Held by:** ritual. This is a hand-rolled implementation of the "Close the Loop" standard — re-surface a thing until it is real. Replace with that standard's machinery rather than maintaining by hand._

Reaffirm the tenets WORD FOR WORD (verbatim, not a summary or shorthand) at the beginning, middle, and end of each window, so that we don't suffer from the dilution or a copy of a copy effect where important details start getting left out.

## Goals 2–4 — REFINEMENT / making the delegation mandate EXPLICIT (Justin, 2026-08-19 — APPROVED by Justin 2026-08-19)

_**Binds:** us · **Held by:** ritual._

The orchestrator (Pathway) is meant to ORCHESTRATE work — not perform it itself. Justin's words (36966, 2026-08-19): "generally speaking, the orchestra[tor] is meant to orchestrate Work so that it can keep its history relatively light. In other words, the majority of development needs to be offloaded to other topics and other sessions so that the orchestrat[or] history can be high-level and could be easily reviewed by the observers." An orchestrator that does the development itself makes its own history heavy and hard for the observers to review — which defeats the observer-review structure (goals 2, 8, 9). This was implicit in goals 2–4 (Pathway "in turn orchestrates the worker sessions"; "main work offloaded to the laptop"; "MULTIPLE worker sessions being Codey"), and is now made EXPLICIT: the majority of development MUST be offloaded to worker sessions/topics; the orchestrator's own history stays high-level and light. (Occasioned by W20: Pathway built all eleven revisions itself in its own session instead of delegating.)

## The 80/20 standard (Justin, 2026-08-19 — APPROVED by Justin 2026-08-19)

_**Binds:** anyone · **Held by:** ritual. PROMOTION CANDIDATE — binds anyone but has no guard. Named "standard" here, but it is a tenet until a guard exists._

Apply a global 80/20 (Pareto) standard to everything we do — "or to at least tasks that are complex enough to have such a long tail" (Justin's words, 36966, 2026-08-19). Deliver the high-value core; do not grind the long tail inside the orchestrator's or observer's own work. (Occasioned by W20: 11 review rounds / ~15h hardening the drill instrument — the long tail — while the drill's actual finding, that unattended recovery fails in the wild, was already in hand after the first real incident.)

## Tenet 12 (proposed by both observers 2026-08-20 — APPROVED by Justin 2026-08-20, "Yes and yes, go", 36966)

_**Binds:** us · **Held by:** ritual (it states a closure gate, but no guard on disk enforces it). Also a hand-rolled "Close the Loop"._

Every re-ground records the canonical plan document's identifier, its last-updated timestamp, and the exact current-work node it used. A window cannot claim closure while the plan's current-work layer and outcome remain stale.

The canonical plan document is "Where this project stands" (Mini private view 3a08766f-5738-474f-8857-b713f753a7e2, same link always). It is the mandatory INPUT of every between-windows re-ground (open it, state its last-updated date) and the mandatory OUTPUT of every window (the window's honest result written onto the goal tree before closure). (Occasioned by W19-W21: the doc froze at the W18 close while three windows each rebuilt their own picture beside it — the artifact-level copy-of-a-copy effect; awareness without a gate did not bind.)

## Tenet 13 (proposed by Observer 1 2026-08-31 from Justin's ceremony question — APPROVED by Justin 2026-08-31, "Yes, that rule should be in the tenets", 36966)

_**Binds:** us · **Held by:** ritual. The 80/20 standard applied to the window clock itself._

A window closes when its exit test is met — the chartered duration (e.g. 24 hours) is a CEILING, not a duration to fill. If a charter genuinely needs a soak or observation period, that soak gets its own DECLARED length in the charter, and the close ritual starts the moment work-plus-soak is done. Holding a finished window open against an arbitrary clock is ceremony, not work. (Occasioned by W29-W30: in both, the substantive lanes finished within the first ~90 minutes; W30's build lanes all completed ~65 minutes in, and ~21 of its 24 hours were cadence duties plus waiting for a scheduled close time. Justin's question 2026-08-31: "could they have closed early and is the majority of the time spent in ceremony?" — answer: yes.)


---

<!-- RECONCILED 2026-08-21 by Observer 1 on the Mac Studio. The previous Studio copy was STALE (dated
2026-08-19): it still marked tenets 10/11 as PENDING after Justin approved them on 08-19, numbered the
Goals 2-4 refinement as "tenet 12" and the 80/20 standard as "tenet 13", and was MISSING the real tenet
12 (the canonical plan document) entirely. Reaffirming from that copy would have propagated wrong
numbering and dropped a tenet. <!-- RESTORATION GAP 2: the remainder of this reconciliation comment is
truncated in every stored copy on the Studio; the surviving continuation is the source-of-truth note
reproduced below. -->

(4 parts, topic 36966, 2026-08-21T03:44Z) — the messages Justin actually reads, which are signed and
durably stored. Those messages, not any machine's file copy, are the real source of truth.

KNOWN WEAKNESS, NOT YET FIXED: this file is untracked and machine-local, so every machine holds its own
copy and they drift. The previous footer said "reconcile before the next verbatim reaffirmation" — that
is a wish, not a guard, and it did not hold. The structural fix is to derive this file from the stored
reaffirmation messages rather than maintain it by hand. Raised as a proposal, not done. -->

<!-- RESTORED 2026-08-27 ~18:45 PDT by Observer 1 (Echo, Mac Studio). This machine's .instar/TENETS.md
had VANISHED from disk (the Studio disappearing-files problem, same class as the 13-of-15 missing helper
scripts found 2026-08-26). Reconstructed from the stored Window 27 START (2026-08-25 11:24 PDT) and
MIDDLE (17:26 PDT) reaffirmation messages in topic 36966 plus the Window 24 recitation in topic 29723 —
per the footer above, the stored reaffirmation messages are the real source of truth. Every OPERATIVE
section (goals 1-8, tenets 5, 9, 10, 11, 12, both refinements, 80/20) is complete and verbatim. Two
META fragments (marked RESTORATION GAP 1 and 2 above) are truncated in every copy this machine holds;
byte-verify this file against the laptop's copy when that machine is next online. -->
