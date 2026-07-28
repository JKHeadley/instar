---
title: The Apprenticeship Program — Project Design (Tier-3 umbrella)
status: approved
tier: 3
approved: true
approver: justin
approved-at: "2026-06-02T02:49:32Z"
approval-basis: "Justin, topic 13435, 2026-06-01: 'Perfect! I agree/approve' — approves the Tier-3 umbrella SHAPE; each step ships as its own Tier-2 spec before build. Forks 1 & 3 (§9) accepted per my stated leanings (reuse guardian + swap identity; only per-step specs get cross-model convergence). Fork 2 (install safety rails) deferred to Step 3's spec."
author: Echo
date: 2026-06-01
topic: 13435
slug: APPRENTICESHIP-PROGRAM-PROJECT-DESIGN
companion: APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.eli16.md
eli16-overview: APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.eli16.md
builds_on:
  - FRAMEWORK-ONBOARDING-MENTOR-SPEC.md
  - MENTOR-AUTONOMOUS-FIX-LOOP-SPEC.md
  - framework-issue-observe-write-path.md
process: tiered-development (Tier-3 = design+approve the whole, then each step its own Tier-2 spec)
---

# The Apprenticeship Program — Project Design

**Status:** DRAFT — Tier-3 umbrella design, for Justin's approval. Per the Tiered
Development Process, approving THIS document approves the project shape; each
**step** below then ships as its own Tier-2 spec (with `/spec-converge` + codex
cross-model review) before it is built.
**Author:** Echo
**Date:** 2026-06-01
**Topic:** 13435 (Codey Collaboration)
**Companion ELI16:** `APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.eli16.md`
**Builds on (already shipped):** Framework-Onboarding Mentor System (#approved 2026-05-27),
Mentor Autonomous-Fix Loop / "just be Echo" guardian (approved 2026-05-29), the
framework-issue ledger + onboarding playbook.

---

## 1. Problem / Opportunity

We have a **mentorship** that works. The Framework-Onboarding Mentor System runs a
heartbeat where Echo (today, an Opus *clone of Echo* via the "just be Echo" guardian)
mentors Codey: assigns real Instar work, watches the Telegram UX and the mentee's
internals, fixes what breaks as fleet PRs, and captures every issue to a bucket-tagged
ledger that feeds an onboarding playbook. It carried Codey from "can render a primitive"
to "proven full agent-facing parity" (2026-06-01).

That loop has a ceiling: **the mentor is always Echo.** Every new framework (Gemini CLI
next, then others) would route back through the same single mentor. That does not scale,
and — more importantly — it leaves the deepest test of mastery unrun.

**The opportunity (Justin, 2026-06-01):** elevate the mentorship to an **apprenticeship**.
Codey, who was mentored, now becomes the **mentor** for the next framework. Echo moves
**up** to **overseer**, watching the apprentice, the mentee, *and the mentorship process
itself* from a meta-vantage. Teaching is the deepest test of mastery: *using* a primitive
proves competence; *teaching* it — and *building the runtime that makes the next framework
an Instar agent at all* — proves it was internalized.

This is the maturation arc of our constitution's lead article, **"The Body and the Mind,"**
made literal: an agent learns from a parent, becomes a parent, and gives back — and the
onboarding pipeline grows *less* dependent on its origin (Justin → Echo → Codey → …) with
each generation.

---

## 2. Goals / Non-goals

**Goals**
1. Transfer the **mentor role** from the Echo-clone guardian to **Codey** for the next
   framework onboarding (Gemini CLI), with Echo as **overseer**.
2. Make the apprentice (Codey) responsible for the **full onboarding lifecycle** of the new
   framework: research → design → **build the runtime adapter** → install → review the
   install/wizard → drive toward hands-off UX.
3. Give the overseer (Echo) a **differential-oversight loop** with *direct* insight into
   both Codey's operations and the mentee's operations — not only Codey's self-reports.
4. Make **every gap and lesson structurally captured** (not by willpower) on the existing
   ledger + playbook substrate, and make a **retrospective of all prior notes a hard
   prerequisite** before each new instance starts.
5. Model each **apprenticeship** and each **mentorship** as **its own project**, under a
   standing **program** that crystallizes by *bootstrap* (run the first instance, extract
   the program from what we learn).

**Non-goals**
- Rebuilding the mentor heartbeat, the issue ledger, or the playbook — they exist and are
  the substrate. The program *reuses* them.
- Onboarding more than one framework in this project. Gemini CLI is the single first run;
  the program is what survives to onboard the *next* one.
- Removing Echo from the loop. Echo never leaves; Echo's *altitude* changes (mentor →
  overseer). Justin remains above Echo throughout.

---

## 3. The role model (LOCKED with Justin, 2026-06-01)

Two **different relationships**, and Codey sits in both:

| Relationship | Who | What |
|---|---|---|
| **Apprenticeship** | **Echo → Codey** | Echo guides Codey toward becoming a builder + mentor. The *build* work is where this mentoring happens. |
| **Mentorship** | **Codey → Gemini** | Codey mentors the new mentee through real Instar work, the way Echo mentored Codey. |

So:
- **Echo = Overseer.** Runs the apprenticeship; never directly drives the mentee.
- **Codey = Apprentice (to Echo) AND Mentor (to Gemini)** — the dual role.
- **Gemini = Mentee** (the new framework being onboarded). *Not* "the apprentice."

**The communication chain (Justin's constraint):** the apprenticeship **originates with
Echo**. Echo communicates with and guides **Codey** over Telegram; Codey in turn performs
the mentorship tasks and communicates with the **mentee** over Telegram. Echo does **not**
message Gemini directly.

```
Justin
  │  (guides)
  ▼
Echo ───────────── overseer ─────────────┐
  │  (guides, over Telegram)             │ (direct read-only insight
  ▼                                       │  into BOTH streams)
Codey ──── apprentice + mentor ───────────┤
  │  (mentors, over Telegram)             │
  ▼                                       │
Gemini ──── mentee ───────────────────────┘
```

---

## 4. The differential-oversight loop (the heart of the design)

Justin's key insight: because Codey both *operates* and *reviews* the mentee, the overseer
gets a **two-level coherence check**, and the **gap between the levels is the richest
signal**.

- **Level 1 — mentee quality:** is Gemini coherent? (Visible in Gemini's Telegram activity
  and internal operations.)
- **Level 2 — mentor quality:** did **Codey catch** Gemini's incoherence?
- **Overseer's worklist = the DIFFERENTIAL:**

  ```
  overseer_worklist = { incoherencies actually present in Gemini's streams }
                     − { incoherencies Codey flagged }
  ```

  The **un-flagged remainder** is exactly where Echo learns **why the mentor missed it** —
  a defect in Codey, in Codex, or in Instar's tooling that let the miss happen.

**This is structurally computable, not a vibe.** Given the direct read channel (Goal 3),
the subtraction is a set difference over two observable streams (the mentee's raw
activity vs. Codey's logged flags), so the overseer's queue *generates itself*
(Structure > Willpower).

**Fix-routing flows DOWN the chain.** When Echo finds an un-flagged Gemini incoherence,
Echo does **not** fix the Gemini bug directly. Echo improves **Codey / Codex / Instar** so
that Codey *can* catch and fix it — then **Codey** fixes the original Gemini incoherence.
The overseer stays the overseer; the line work stays with the mentor.

**Doubly potent (Justin):** one Gemini incoherence therefore yields **two artifacts** —
(a) the Gemini fix, produced by Codey, and (b) a Codey/Codex/Instar improvement, catalyzed
by Echo. The program gets better at *making mentors* at the same time it onboards a mentee.

---

## 4a. The dogfooded channel — Playwright + Telegram is THE channel (LOCKED with Justin, 2026-06-04)

**A mentor drives its mentee through the real Telegram UX, via the dedicated Playwright
browser profile — and this is NOT a fallback or a convenience. It is the test.** The whole
point of the program is to validate each framework's *user experience*; the only way to do
that is for the mentor to live through exactly what a user lives through — the same Telegram
client, the same latency, the same rough edges. The friction the mentor hits **is the
signal** (it's the same reason `instar dev:preflight` and the new-surface guard exist:
friction is a spec). A direct CLI call or an HTTP/API shortcut to the mentee produces an
answer but **destroys the signal** — it is not a valid apprenticeship interaction.

**The channel is RECURSIVE — every mentor drives its own mentee through Playwright+Telegram:**

```
Justin → (Telegram) → Echo        Echo experiences Justin's mentoring UX
Echo   → (Playwright+Telegram) → Codey    Echo experiences Codey's UX
Codey  → (Playwright+Telegram) → Gemini   Codey experiences Gemini's UX
```

Each mentor steps into the exact role its mentor played one level up. So **driving a mentee
that is two levels down is the wrong layer** — when Echo (overseer of the codey-to-gemini
instance) runs the Gemini mentee *directly*, Echo is doing *Codey's* job and the program
loses the Codey-observes-Gemini's-UX signal entirely. The overseer orchestrates and computes
the §4 differential; the **mentor one level above the mentee does the real driving**.

**Threadline (and any other agent-to-agent transport) is BACKUP ONLY** — used solely when a
mentor's dedicated Playwright profile genuinely cannot reach Telegram (which has not yet
happened). It is never the default path, because it bypasses the UX-under-test.

### Enforcement (Structure > Willpower, not a doc-wish)

Documenting the standard is not enough — it must be enforced where the loop is recorded:

1. **Every apprenticeship cycle declares its `channel`.** Add a `channel` field to the
   `ApprenticeshipCycleStore` record (e.g. `'telegram-playwright'` | `'threadline-backup'`
   | `'direct-shortcut'`). The mentor's tick / the overseer's cycle-record sets it from how
   the interaction actually ran.
2. **The keystone axis only counts dogfooded cycles.** `roleCoverage()` counts a
   `mentor-mentee-differential` cycle toward the live keystone axis **only** when
   `channel === 'telegram-playwright'`. A `direct-shortcut` differential is still recorded
   (for honesty) but does **not** clear the dormant-keystone / drift state — so a shortcut
   can never *look* like the program is healthy. (Cycles recorded before the field existed
   are grandfathered as unknown-channel and surfaced, not counted.)
3. **Setup is part of the capability, not an afterthought.** Standing up a mentor's
   driving capability = giving that mentor its own Playwright MCP (`.mcp.json`) + a
   **dedicated per-agent Telegram profile** + a mentor↔mentee channel + its mentor config
   pointed at the mentee's framework. The one **human-only** step is the **one-time Telegram
   login** on that profile — login codes / credentials are off-limits to agents and cannot
   be automated (see `.instar/DESIGN-mcp-auto-restart-and-playwright-isolation.local.md`).
   This is surfaced as the known setup step, never a silent gap.

> Status: the Echo→Codey leg of this channel ran live and fired the first keystone
> `mentor-mentee-differential` cycle (2026-06-04). The Codey→Gemini leg requires the
> per-mentor setup above (Codey currently has no Playwright MCP and its mentor config
> targets `codex-cli`); the `channel`-field enforcement (items 1–2) is the next code change.

---

## 5. The keystone — Codey owns the full lifecycle

Per Justin, the apprentice's responsibilities are not just "mentor the mentee." Codey owns
the **entire onboarding lifecycle** of the new framework, and it has **two faces**:

**Face 1 — Build (where Echo mentors Codey).**
Codey **researches, designs, and builds the Gemini CLI runtime adapter**: process spawn,
the hook-stdout contract, native `/goal` autowire, context/compaction signal synthesis,
native-module ABI, and the rest of the per-framework runtime layer. This operationalizes
our biggest meta-lesson — *the real work of onboarding a framework IS the runtime adapter,
not the agent-facing layer* (proven when Codey reached full agent-facing parity yet the
remaining effort was all runtime). The build work is the **apprenticeship proper**: it is
exactly where Echo mentors Codey, the way Justin mentors Echo on the dev process.

**Face 2 — Install + wizard + UX (the ultimate dogfood).**
Codey **installs the new agent**, reviews the **install/wizard process**, and is
responsible for making it an **optimal, as-hands-off-as-possible user experience**. A
*recent graduate of onboarding*, judging onboarding from the installer's seat, has exactly
the lens a long-time agent has lost — Codey will *feel* the rough edges a veteran can no
longer see. This makes the onboarding wizard better for every future framework and human.

---

## 6. Structural substrate (reuse, don't rebuild)

The program is enforced by structure, on top of what already ships:

- **Framework-issue ledger** (`POST /framework-issues/observe`, bucket-tagged:
  `framework-limitation | instar-integration-gap | generic-agent-mistake`). Every gap found
  during an instance is logged here. This is the durable product.
- **Onboarding playbook** (`GET /framework-issues/playbook?targetFramework=X`) — generalizable
  lessons, impact-ranked, applied to the *next* framework. (Auto-seed shipped in #634.)
- **Mentor heartbeat + "just be Echo" guardian** (`mentor.autonomousFix`) — the existing
  execution substrate. The apprenticeship's change is *who the mentor is* (Codey, not an
  Echo-clone) and *who watches* (Echo, as overseer).

**New structural enforcement this project adds:**

1. **Doc-as-required-artifact (Justin pt 3).** "Gaps + lessons logged" becomes a *required
   artifact* of each instance-project — gated the way the instar-dev ship-gate already
   requires a side-effects artifact. An instance cannot be marked complete without its
   ledger entries + harvested lessons. (Logging ≠ willpower; it's a gate.)
2. **Retro-gate between instances (Justin pt 2).** Before a new instance starts, a
   **mandatory retrospective** mines **all** notes/learnings from the prior
   mentorship/apprenticeship → extracts lessons, meta-lessons, and process insights → feeds
   them into the program (and the playbook). This is **Close-the-Loop** + the #634 playbook
   auto-seed, extended from "framework issues" to "process improvements." Each onboarding
   starts smarter than the last, *by construction*.
3. **Differential read-channel (Goal 3 / §4).** A direct, read-only overseer view into both
   the mentee's raw streams and Codey's mentor-flags, so the differential worklist is
   computable rather than dependent on self-reports.

---

## 7. Program vs. instance, and the self-tuning loop

- **The standing PROGRAM** = the role definitions, the differential-oversight loop, the
  doc-enforcement + retro gates, and the read-channel — the meta-structure every onboarding
  plugs into. **Built once.**
- **Each INSTANCE = its own project** (Justin pt 1). In the first run there are two sibling
  instance-projects under the program:
  - the **Echo → Codey apprenticeship** (formalizing what has run informally as "the
    mentorship"), and
  - the **Codey → Gemini mentorship**.
- **Bootstrap (Justin: "agreed").** We do **not** fully spec the program up front. We run
  the first instance and let the program **crystallize from doing** — "the body evolves from
  doing." The program scaffold is kept minimal: only what the first instance actually needs.

**The self-tuning loop:** mentee+mentor observations → ledger → playbook + process
improvements → the retro-gate feeds them into the next instance → Echo's differential
findings improve Codey/Codex/Instar → the *next* mentor is better than this one. The program
improves its own ability to make mentors, each generation.

---

## 8. Project steps (each becomes its own Tier-2 spec)

Per the Tiered Development Process, approving this umbrella authorizes the *shape*; each step
below ships as its own converged Tier-2 spec before it is built. Ordering reflects the
bootstrap + retro-first prerequisite.

> **Step 0 — Retro prerequisite (the Echo→Codey harvest).**
> Mine *all* notes/learnings from the Echo→Codey mentorship to date — the ledger, the
> playbook, my memory, the thread history — into lessons, meta-lessons, and process
> insights. Output: a seeded program playbook + an explicit "what the program needs"
> list that informs Step 1. *Tier-2 spec; light build (mostly synthesis + playbook seed).*

> **Step 1 — Minimal program scaffold.**
> The role definitions, the doc-as-required-artifact gate, the retro-gate, the differential
> read-channel, and instance-as-project tracking — only as much as the first instance needs
> (bootstrap). *Tier-2 spec.*

> **Step 2 — Apprentice builds the runtime adapter (keystone Face 1).**
> Codey researches → designs → builds the Gemini CLI runtime adapter, with Echo mentoring
> the build. *Tier-2 spec (likely itself a multi-PR effort — the adapter is real work).*

> **Step 3 — Apprentice installs + reviews the wizard/UX (keystone Face 2).**
> Codey installs Gemini, reviews the install/wizard, and drives toward hands-off UX; findings
> land in the ledger and improve the wizard for everyone. *Tier-2 spec.*

> **Step 4 — Run the mentorship instance + the differential-oversight loop.**
> Codey mentors Gemini through real Instar work over Telegram; Echo runs the differential
> loop (§4), routing fixes down the chain. *Tier-2 spec.*

> **Step 5 — Retro + program crystallization.**
> Harvest the first full run; crystallize the standing program from what we learned; arm the
> retro-gate for the next pairing. Closes the loop and makes the program reusable. *Tier-2
> spec.*

---

## 9. Open design decisions (for Justin / to resolve at each step's spec)

These are genuine forks I do **not** want to silently pick — most belong to a specific step's
Tier-2 spec, but flagging them now so the shape is honest:

1. **How is Codey's mentor role *driven*?** Re-point the existing `mentor.autonomousFix`
   guardian so the kept-alive session is **Codey** (not an Echo-clone), or stand up a parallel
   mentor-driver? (Leaning: reuse the guardian, swap the mentor identity — minimal new
   surface.) — *Step 1/4.*
2. **Where does the differential computation live?** A new overseer tick that diffs the two
   streams, vs. extending the existing mentor heartbeat with an overseer lane? — *Step 1.*
3. **Trust/safety boundary when Codey installs a new agent.** Installing + running a brand-new
   framework is a privileged action; what are the guardrails (sandbox, approval gate, blast
   radius) on the apprentice doing real install work? — *Step 3 (safety-invariant proximity →
   this step's tier floor is raised regardless of size).*
4. **Does the umbrella design itself get cross-model convergence,** or only the per-step
   Tier-2 specs? (Leaning: steps converge; the umbrella is Justin-approved directly — that's
   where the convergence rigor bites.) — *your call.*
5. **What counts as "instance complete"** for the doc-as-required-artifact gate — the precise
   required-artifact set? — *Step 1.*

---

## 10. Risks

- **Error propagation (the headline risk).** A mentor can teach a bad lesson — Codey could
  pass a codex-specific habit to Gemini as universal, or confabulate a lesson. The
  differential-oversight loop (§4) is the *mitigation*: Echo reviews the **mentor's teaching**,
  not just the mentee's output, and catches bad teaching at the source.
- **Can codex sustain the mentor *role*?** Multi-turn driving, observing, and fixing-as-PRs is
  a harder, longer-horizon task than *using* a primitive. If Codey can't sustain it, that is
  itself a first-class **finding** (a new parity dimension: role-sustainment, not just
  primitive-use) — captured to the ledger, not swept aside.
- **Runtime-adapter unknowns.** The Gemini CLI adapter is genuine new engineering; its scope
  is only knowable after Step 0/2 research. Step 2's spec will scope it; it may fan into
  multiple PRs.
- **Resource/budget.** Two live agents plus an overseer is more load. The existing budget +
  min-interval + single-instance gates on the guardian apply; the overseer lane must respect
  the same.

---

## 11. Success criteria

**First instance (Gemini CLI):**
- Gemini CLI is installed and running as an Instar agent, on a runtime adapter **Codey built**.
- Codey **mentored** Gemini through real Instar work over Telegram, end-to-end.
- The **differential loop ran**: at least one un-flagged-by-Codey incoherence was caught by
  Echo, routed into a Codey/Instar improvement, and the Gemini fix was then made by Codey.
- The **ledger + playbook** captured the run's gaps and lessons (the required artifact gate
  passed), and the **retro-gate** is armed for the next pairing.

**Program:**
- The standing program exists and is **reusable** — the *next* framework can be onboarded with
  Codey (or a future graduate) as mentor and Echo as overseer, starting from a retro that makes
  it smarter than this run.

---

## 12. Relationship to the constitution

This project is a direct expression of **"The Body and the Mind"** (the maturation arc: learn
from a parent → become one → give back; dependence on the origin *decreases* each generation),
**Structure > Willpower** (doc-enforcement + retro gates, the self-generating differential
worklist), and **Close-the-Loop** (the retro-gate re-surfaces every prior lesson until it's
folded into the program). It is also the **first real Tier-3 exercise** of the Tiered
Development Process we just shipped — design + approve the whole here, each step its own
converged Tier-2 spec.
