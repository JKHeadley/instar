# What to take from Dots, Muse and Grok Bot

Written 2026-10-21, after hands-on exploration of ChatGPT **Dots**, Meta **Muse**
and xAI **Grok Bot**. Per-product inventories with a verdict on every feature are
in `dots/`, `muse/` and `grokbot/`; each records what I could not observe.

Instar is not any of these products. It is an operator console for persistent
agents that already do most of what these three advertise. So the useful question
was never "what features do they have" — it is **"what have they solved about
*showing* an agent that we haven't."** Almost everything worth taking is
presentational.

---

## Where two or three of them independently agree

Convergence is the strongest signal in this research. Three separate teams, no
shared code, same answer:

### 1. The agent discloses what it is doing and what it was allowed to do — *all three*
- **Dots**: discloses judgments it made on your behalf.
- **Muse**: a live snippet of current work under the avatar; tapping it shows the
  full activity log *and the permissions you approved*, together.
- **Grok Bot**: a fleet list where every agent shows its last action in one plain
  sentence.

**This is the headline finding.** Instar holds strictly more of this information
than any of them — every gate decision, every override reason, every mandate,
every reap, every commitment — and surfaces strictly less of it. That gap is the
entire argument for the rebuild.

### 2. Capability discovery is the real problem, and a menu is not the answer — *Muse and Grok Bot*
- **Muse**, in Meta's own words: *"Muse could do so much that people didn't know
  where to start."* Their answer: the agent proposes, from your goals and patterns.
- **Grok Bot**: Automations is a gallery of **outcomes** grouped by life-category
  — News, Productivity, Finance — each one line, each one click to add.

Our 29 tabs are the same disease. Note that Grok's entire product navigates from
**five** sidebar items while containing a scheduler, a plugin system, an image
model and a cloud agent platform. Many capabilities do not require many tabs.

### 3. Proactivity changes the shape of the interface — *Muse, and Instar already lives it*
Muse: *"Once messages can arrive out of turn... a flat, unbounded transcript stops
being readable. That's why Muse uses chat bubbles."* A concrete consequence of
proactivity that Instar shares and has never reasoned about. Any Instar chat
surface must treat out-of-turn arrival as the normal case.

---

## Ranked adopt list

Ordered by value to Instar, not by how impressive they look.

**1. "Take over / I'm done" — hand the human the live session at a wall** *(Grok Bot)*
The agent hits something only the human can pass — a login, a consent, an identity
field — and instead of failing or messaging and waiting, it hands over its own
session in place. The human acts; the agent resumes; nothing restarts.

I can vouch for the cost of not having this: it stopped this very research three
times in one night (a Google sign-in, an age field, a terms gate), each time
converting a five-second action into a message and a wait. Instar has every piece
— a reachable browser, a dashboard, a tunnel, durable session state — and no such
interaction. **Build this first.**

**2. Always-visible "what is it doing, and what may it do"** *(all three)*
See convergence 1. For Instar this is fleet-scale: many sessions, topics and
machines, each with a last action and an authority. The data exists today.

**3. A gallery of outcomes, grouped by what the operator cares about** *(Grok Bot)*
Not a feature list — one-line finished outcomes, one click to enable. Instar's
scheduler is more capable than Grok's Automations and currently has **zero jobs
defined**, because nothing suggests what a job could be. The definitions are
already declarative; this is mostly writing.

**4. Memory and standing decisions shown as they are recorded** *(Muse, Grok Bot)*
Muse lets you read and edit memory files directly. Grok shows *"Updated memory for
Account Manager"* inline. Instar writes memory constantly and silently. This is
the cheap half of the approval-forgetting problem: a standing decision you can
watch being recorded is one you can correct before it hardens.

**5. Config and history as adjacent-but-separate views** *(Grok Bot)*
"What is scheduled" next to "what actually ran". Instar has both and shows neither.

**6. Volunteered capability boundaries** *(Grok Bot)*
*"Hex, Gmail and LinkedIn are already signed in. Salesforce isn't."* Said when
taking the work, before failing. Instar has the data behind an endpoint and a rule
telling me to check it — but checking is willpower, volunteering is design.

**7. Deterministic UI as a stated rule** *(Muse)*
Meta names exactly where conversation is not allowed to be the interface: approval
cards, and credential storage. Instar has the same instinct scattered implicitly.
Worth writing down as a console rule.

**8. Reversibility as the approval boundary** *(Muse)*
*"The default allows standard browsing and stops for anything hard to undo."*
Confirms Instar's rung floor, with better phrasing for a user-facing setting.

**9. Rich outputs as cards in the conversation** *(Muse Artifacts, Dots)*
Instar's private views are already richer. The borrow is presentational: a typed,
titled, timestamped card in the thread, not a bare link.

---

## What not to copy

**Naming a problem and shipping the surface anyway.** Muse names "banner
blindness — where people approve everything to make it go away", then ships
approval cards with no stated way to know whether anyone reads them. Instar
already records every gate decision and every override reason, so it can *measure*
approve-without-reading. This is the one place Instar is positioned to beat all
three rather than catch up — and the one most likely to be quietly dropped,
because measuring your own approval surface is unflattering.

**Asking for the broadest grant at the moment of least context.** Watching Grok
Bot's onboarding first-hand turned this from theory into an example. Its opening
move, before the agent has done anything at all, is an **Authorize** button over
the operator's Gmail — *search, read, draft and manage* — carrying the reassurance
"nothing gets sent without your approval". The reassurance is about *sending*; the
scope grants *reading everything*. Muse names banner blindness in an essay and xAI
ships it in the first thirty seconds.

The ordering is the mistake, not the wording. A grant requested before any
demonstrated work gives the operator nothing to judge it against, so the only
available response is yes or abandon. **Earn the grant with visible work, then ask
for the narrowest scope that work needs.** Instar's rung ladder already says
something close to this; what it lacks is the product discipline of never putting
a broad ask in front of someone who has not yet seen the agent do anything.

**A status list made only of successes.** Every status line in Grok's material is
cheerful: "sent", "filed", "drafted". An operator console's hardest job is telling
working from slow from quietly failed. Which brings us to:

**The failure none of them design for, and the one Instar must.** Across this
research, the same failure recurred five separate times from unrelated causes: a
full temporary disk hanging a commit with no error; a scheduler reporting itself
enabled while being structurally absent; a cookie banner silently swallowing
clicks; an emulator saying "two minutes, or more" then nothing; a sign-in dropping
out with no message. In every case the instrument reported *health or nothing* while
the thing was broken.

Three times tonight my own instruments did the same: a node dump that omitted the
"Wrong password" error visible in the screenshot; a byte count that read a 12-character
password as 36; a two-minute timeout that looked like a hang and was a slow lint.

**A console that cannot distinguish working from stuck lies by omission.** None of
these three products show any sign of designing for it. Instar should treat
"slow vs stuck vs silently failed" as a first-class display state, not an edge case.

---

## What Instar already has that is stronger

Worth stating so the rebuild does not accidentally regress them:

- **Delivery honesty.** Grok's documented agent-to-agent hand-offs have no notion
  of "did it actually arrive?" Threadline has signed identity, trust levels,
  delivery receipts and pairing.
- **Flood control.** Muse's "notify only when meaningfully new" is one sentence;
  Instar has attention budgets, coalescing and circuit breakers built from real
  incidents.
- **Follow-through.** Muse's Goals tab tracks tasks; Instar's commitments carry
  owner, blocked-on, beacons and dead-letters — and have no user-facing surface
  at all. This is the single largest existing capability with no face on it.
- **Identity.** Muse's avatar creation wizard is a nice onboarding beat. Instar
  agents have names and histories that arrived through use. Do not replace the
  latter with the former.

---

## What this means for the console

The rebuild's three groups were: most-used (sessions, subscriptions, files),
secondary, and advanced. This research sharpens that:

- The **first screen** should answer convergence 1 — what every agent is doing and
  what it is allowed to do — not present a navigation menu.
- **Discoverability is a content problem, not a layout problem.** A gallery of
  one-line outcomes beats any arrangement of 29 tabs.
- **"Take over" is a feature, not a tab**, and it is the one with the clearest
  evidence of need.
- Group 3 should not be "advanced settings" so much as *the audit surfaces* — and
  those are Instar's strongest material, not its most embarrassing.

---

## Honest limits of this research

- **Dots**: explored hands-on; the connector install was deliberately abandoned
  rather than grant scopes on the operator's personal account.
- **Muse**: documentation and product page only. The signed-in app needs a code
  sent to the operator's phone or email. The design essay is first-party and
  detailed, but it is a company describing its own product.
- **Grok Bot**: fully hands-on. The surrounding app (Automations, Projects,
  Library, sidebar) and then Bot itself — a second operator account already
  carried the subscription. Onboarding, the bot identity panel, and the
  Connectors / Skills / Bots catalogues are observed. Its always-working
  background behaviour is not: no short session can verify that.
  I declined the Gmail grant, so nothing downstream of it was exercised.

Where a claim is the vendor's rather than mine, the per-product documents mark it.
