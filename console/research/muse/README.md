# Muse (Meta) — feature inventory and verdicts

Observed 2026-10-21. Sources: Meta's own design essay `introducing.muse.ai`
("How We Designed Muse", Mona Sarantakos with Christine Awad, Sept 2026) and the
product page `muse.ai`, both captured first-hand with screenshots and full page
text (see "Evidence" below).

Muse is the closest external analogue to Instar I have found: a *persistent,
proactive agent with its own computer* rather than a chat window. That makes its
design decisions unusually transferable — and its mistakes unusually relevant.

---

## What I could not observe

**The signed-in application UI.** Muse logs in with a code sent to a phone number
or email address — not a Google or Meta account. I could not complete that
without the operator reading a code to me, so every verdict below is drawn from
Meta's published design rationale and product page, not from driving the app.

Concretely, this means:
- I have **not** seen the real Goals tab, Ideas tab, activity log, or approval
  cards — only Meta's descriptions and their marketing screenshots of them.
- I have **not** tested how the proactivity actually feels in use, which is the
  single thing most worth knowing and the easiest to get wrong from a blog post.
- Claims below marked *(claimed)* are Meta's words about their own product. They
  are design intent, not verified behaviour. I have kept them separate from what
  a screenshot actually shows.

The earlier Android-emulator route was abandoned deliberately: it needed a Google
sign-in *and* a Muse account code, and the web product needs only the latter. The
emulator work is not wasted — it is the route to take if we ever need the mobile
app specifically — but it was the long way round for design research.

---

## Features, with verdicts

### 1. A snippet of current work under the avatar — **adopt**
> "under the Avatar, you'll see a snippet of what it's working on"

The agent's current activity is ambient and always visible, not something you
navigate to. Instar already *has* this data (the parallel-work index, `lastAction`,
session state) and currently buries it behind a tab. This is the cheapest high-value
borrow available: one always-visible line answering "what is it doing right now?"

### 2. Tap the avatar for full activity log **and approved permissions** — **adopt**
The pairing is the insight. Activity and the permissions that authorised it live in
one place, so "what did it do?" and "what is it allowed to do?" are answered
together. Instar splits these across the audit trails, `/mandate`, and `/guards`.

### 3. Memory files the user can read **and edit directly** — **adopt**
> "your Memory files, which you can read and edit directly"

Instar has the harder half of this already (durable memory, the file viewer).
What it lacks is the framing: memory presented as *the user's* editable artifact
rather than agent internals. Directly serves Justin's "approval-forgetting" goal —
if the agent's memory is legible and editable, a wrong standing decision is
fixable without a conversation.

### 4. Goals tab — **adopt (as Commitments)**
> "we needed more than just an activity tab — we needed a clear view of
> everything Muse was tracking for us, and its plan to get there"

This is Instar's commitment store with a face on it. Instar's version is arguably
stronger (owner/blockedOn, beacons, dead-letters) and has no user-facing surface
at all. Highest-value *existing* capability to expose in the rebuild.

### 5. Explicit "deterministic UI is non-negotiable here" principle — **adopt**
> "we were deliberate about where deterministic UI is non-negotiable: structured
> approval cards with clear accept/reject actions, and secure storage for
> credentials"

A stated rule for *when conversation is not allowed to be the interface*. Instar
has the same instinct scattered implicitly (PIN gates, Secret Drop, plan flows)
but never written as a design rule. Worth adopting as an explicit console rule:
approvals and credentials are always structured UI, never prose.

### 6. Reversibility as the approval boundary — **adopt**
> "the default allows for standard browsing of the web and stops for anything
> hard to undo"

Identical in spirit to Instar's rung floor (irreversible/cost-bearing actions
have a minimum rung of 1). Confirms the boundary choice is right, and the phrasing
is better than ours for a user-facing setting.

### 7. Naming banner blindness as a design enemy — **adopt (as a metric)**
> "we also wanted to avoid banner blindness — where people approve everything to
> make it go away"

Meta names the failure but describes no measurement. Instar can go further: it
already records every gate decision and every override reason. An approval surface
whose *approve-without-reading rate* is measurable is a genuine differentiator,
not a copy. This is the one place where Instar is positioned to beat Muse rather
than catch up.

### 8. Artifacts — rich outputs that live outside the chat — **adapt**
> "If you asked a person to plan a trip, you wouldn't want a 2,000 word reply;
> you'd want an itinerary."

Right diagnosis. Instar's equivalent is private views, which are already richer
(auth-gated, updatable, tunnel-reachable). The borrow is presentational: artifacts
appear as *cards in the conversation* with a type, title, and timestamp, not as
links. Confirmed visually in the captured screenshots.

### 9. Ideas tab / proactive capability discovery — **adapt, and it is our 29-tab problem**
> "Muse could do so much that people didn't know where to start"

This is precisely the problem the console rebuild exists to solve, admitted by a
team with far more design resource. Their answer — have the agent generate
suggestions from your goals and patterns — is better than a menu. Instar has the
raw material (`/capabilities`, guard posture, parallel work) to do the same.
Adapt rather than adopt: Instar's suggestions should be grounded in *observed
state* ("your scheduler has no jobs defined"), not inferred interests.

### 10. Side chats for separate context — **already have (topics)**
Arrived at by the same route we did: one long conversation, until projects grew
complex enough to need separation. Mild validation that Instar's topic model is
the right shape.

### 11. Chat bubbles justified by proactivity — **adopt the reasoning**
> "Once messages can arrive out of turn... a flat, unbounded transcript stops
> being readable. That's why Muse uses chat bubbles."

A concrete, non-obvious consequence of proactivity that Instar shares and has
never reasoned about. Any Instar chat surface must assume out-of-turn arrival as
the normal case, not the exception.

### 12. "Notify only when meaningfully new" — **already have, and ours is stronger**
> "it evaluates whether the result is worth surfacing, and notifies you only when
> something is meaningfully new or needs your input"

Instar's flood guards, attention budgets and coalescing are a more developed
version of this, built from real incidents. No action.

### 13. A named, user-created avatar with its own personality — **reject for the console**
Meta reports this is "one of the core features people light up about most", and I
believe them — but Instar agents already have names, identities and histories that
arrived through use, not a creation wizard. Adding avatar customisation to the
console would be cargo-culting the surface of something Instar has more honestly.

### 14. Agent has its own cloud computer, shared with the user — **not a console concern**
> "Muse Secure VM is a persistent, isolated Linux computer... It's your computer
> and your browser" *(claimed)*

Architecturally this is what Instar already is, minus the isolation. Noted as
confirmation of direction, not as a console feature.

---

## The one thing I would steal first

Items 1 + 2 together: **the agent discloses what it is doing and what it was
allowed to do, in the same always-visible place.** Instar holds strictly more of
this information than Muse and shows strictly less of it. That gap is the whole
argument for the rebuild, and it is also what Dots got right (the agent disclosing
judgments made on your behalf) — two independent products converging on the same
answer is the strongest signal in this research so far.

## The one thing I would not copy

Muse names banner blindness and then ships approval cards anyway, with no stated
way to know whether users are reading them. Shipping the surface without the
measurement is how approval fatigue arrives quietly. Instar should not repeat it.

---

## Evidence

Captured first-hand, 2026-10-21, with a headed browser:
- `design.txt` — full text of Meta's design essay (9,049 chars)
- `design-00.png` … `design-05.png` — the essay, scrolled, including product
  screenshots of Artifact cards
- `product.txt`, `product-00.png` — the Muse product page

Screenshots live under `.instar/proto-serve/research/muse/` on the Studio and are
deliberately not committed (same policy as the Dots inventory); regenerate with
`/tmp/claude-1000/meta3.mjs`.
