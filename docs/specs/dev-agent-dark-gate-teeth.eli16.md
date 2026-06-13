# Dev-Agent Dark-Gate Teeth — Plain-English Overview

## The one-sentence version

Make it impossible to quietly park a *safe* feature in the "off even for the
people building Instar" pile — a feature can only go there if it proves it would
actually be dangerous to run on a dev agent.

## Why we need this

Instar ships new features **dark** (off) for everyone, but **live** for
"development agents" (like Echo) so they get dogfooded before the fleet gets them.
A few weeks ago we built the machinery that enforces this: every off-by-default
feature has to be filed into one of two drawers —

- **"dogfood on dev"** (safe — runs live on Echo, dark on the fleet), or
- **"off even on dev"** (each tagged with a reason: it deletes things, it spends
  money, etc.).

The problem: the "off even on dev" drawer had a junk slot called
**`deliberate-fleet-default`** — basically "off because we said so," with no
requirement to prove the feature is actually unsafe. So safe features kept landing
in it by accident. The single-negotiator lease (Phase 1) got mis-filed there and
it silently starved the feature's own roll-out telemetry — Justin caught that one
by hand. The bucket that *let* it happen is still open.

Right now, **6 of the 11** features in that drawer literally admit it in their own
notes: *"observe-only … candidate for dev-gating in a follow-up audit."* They're
safe; they're just hidden. This is that follow-up audit — done structurally so it
can't happen again.

## What this changes

1. **Delete the junk slot.** `deliberate-fleet-default` is removed. To be "off even
   on dev," a feature must name a *concrete* reason it's unsafe there: it
   **kills/deletes** things, it **spends money**, it **takes a real action**
   (merges a PR, sends the operator a message), or it **needs setup it doesn't have**
   yet. No "because we said so."

2. **A new honest label: `action-bearing.`** Two real features (the green-PR
   auto-merger, and the agent-to-agent check-in summarizer that messages you) are
   genuinely unsafe to run live on dev — not because they're destructive, but
   because they *do something out in the world*. They get this label instead of
   being forced into a wrong one.

3. **Move the *verified* safe ones to "dogfood on dev."** Each candidate is checked
   against its actual code first — "observe-only" has to be true in the code, not
   just in the note. That check did its job: of the 7 candidates, **4 passed and go
   live** (parallel-work sentinel, failure-learning loop, release-readiness watcher,
   boot health responder), and **3 were caught and held back** because their code
   disproved the "harmless" label:
   - *correction-learning* secretly **spends money** (a small AI summary on every
     preference message you send, ~25¢/day cap) → filed as "spends money."
   - *apprenticeship-cycle SLA* and *gemini-capacity escalation* both **auto-post a
     Telegram alert** → filed as "takes a real action."
   You can still flip any of the 3 on for Echo yourself later — they're opt-in, not
   banned.

4. **The lint grows teeth.** CI now fails if anyone ever tries to use the deleted
   junk slot again. Structure, not a reminder.

The whole fleet's behavior is **unchanged** — every one of these features is still
off for everyone except development agents. No change on Dawn's side.

## The decisions that were yours (both resolved)

- **O1 — Move the safe features live on Echo? RESOLVED: yes.** You approved moving
  all 7 candidates. The build's code-check then held 3 back (the two Telegram-alert
  ones and the money-spending one, above) because their code disproved "harmless" —
  exactly what the check is for. Final result: **4 go live, 3 stay off** with honest
  reasons. You were told which 3 and why, and you can still switch any on yourself.

- **O2 — Is it OK for Echo to answer the minimal boot /health probe live? RESOLVED:
  yes.** The code-check confirmed it only answers a local "are you alive?" probe and
  never reaches outward, so it moved live.

This was built under the same approve-first gate as the Threadline phases.
