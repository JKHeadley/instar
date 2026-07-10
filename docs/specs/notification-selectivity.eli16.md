# Quiet by Default — plain-English overview

## What this is

Right now, lots of the agent's internal machinery is allowed to message you on
Telegram. The recent fix (July 10) stopped the topic spam — every alert now
lands in the ONE "🔔 Attention" topic instead of spawning its own topic — but
each alert still *pushes a message at you*, one per event, with no volume
bound at all. You approved a bigger redesign on June 13 that never shipped
(its build session was killed the same day and the converged spec file was
lost). This spec is that redesign, rebuilt against today's code. Your words,
June 13: automated messages should be "logs only" by default, with "an
extremely high requirement before sending ANY automated messages to the user,
unless the user requests to hear specific notifications." And again on July
10: "we need to be VERY selective about what gets actually sent to the user
(most should be internal logs)."

The design in one breath: **anything I generate on my own — sentinel notices,
health checks, watchdog reports, job status, "I'm stuck" notes — goes to my
internal logs and a dashboard inbox you can check whenever you want. It does
NOT ping you. You opt in, per category, to anything you actually want pushed.
Only a tiny, code-reviewed "genuinely significant" class (a security incident,
data loss, I-cannot-operate) still reaches the one Attention topic on its own
— and even that is volume-capped. Your normal conversations with me are
completely untouched.**

## How it works, simply

- Every outbound message gets classified at the **last moment before Telegram
  delivery**: is this a real reply to something you said, or is it automated?
  The classification is structural — it keys on where the message came from
  (the reply pipeline vs. a background feature), never on what the text says.
  A background feature cannot dress its message up as a "reply" or as a
  "response to your command" to slip past: those classes must name the exact
  message of yours they answer, and the review lints pin every emitter to the
  categories it's allowed to claim. Anything that can't prove itself is
  treated as automated. (This closes the disguise hole the June-13 review
  found — and this rebuild's own review round closed four more dodge paths,
  including features bypassing the funnel entirely.)
- **Replies to you are never touched.** If I'm answering your message, it
  sends, exactly as today — and every failure direction bends toward
  delivering replies, including when two of my machines are mid-update and
  relaying for each other.
- **Everything else defaults to quiet**: it's written to a durable store,
  shows up in a Notifications view on the dashboard (with an unread count),
  gets logged, and — where it belongs to a project — is routed into the
  session working that project, so issues surface organically where they
  matter instead of pinging you out of context. Items belonging to nothing
  get aged into my own boot context so they can't rot unseen.
- **You opt in per category** ("push me reap notices", "push me quota alerts")
  — conversationally or with a dashboard toggle. Opted-in pushes land in the
  existing Attention topic, never new topics — and even an opted-in category
  is volume-capped (a buggy feature that fires 500 notices gets you 3 plus
  one "…and 47 more, see dashboard" summary, never 500 pings).
- **I cannot opt myself in.** Every opt-in write requires a recorded operator
  confirmation (your dashboard PIN, or your explicit yes in conversation),
  is audited, and a burst of opt-in changes raises its own alert. The
  current opt-in list is always visible on the status page and in the digest.
- **Nothing is ever silently lost.** If the quiet store itself breaks, that
  failure is one of the few things loud enough to reach you — with an honest
  count of anything that couldn't be recorded.
- A **CI test enforces the whole thing forever**: fire 1,000 automated signals
  through the real pipeline — if even ONE stray message would push to you
  without an opt-in, the build fails. Zero, not "a few." A second arm proves
  an opted-in category stays inside its volume cap.

## What already shipped and stays

The July-10 single-Attention-topic routing, the flood guards and topic budget,
the tone gate on my conversational messages, the advisory layer that keeps
jargon/file-paths out of automated job sends, the calm Agent Health lane, and
duplicate suppression all stay exactly as they are. This spec adds the one
missing layer they don't have: *whether an automated message should push at
all* — and fixes one real gap the review found in the July-10 fix itself (the
hub had no per-source message cap; now it does). Rollout is careful: dark
first, then observe-only on the dev agent (it logs what it WOULD suppress but
delivers everything), then enforcement on dev, then the fleet — and the last
two steps are YOUR flips, made on presented evidence, not mine.

## The decisions you'd be confirming (each has a default — override any)

These are the open questions, in plain English. Each is resolved in the spec
with a recommended default so the build never has to stop and ask — but every
one of them is genuinely yours, and saying "change #N" is enough.

1. **What counts as "significant enough to push without opt-in"?** Default: a
   tiny hardcoded set — security incident, data loss, agent-cannot-operate —
   each defined with concrete "is / is NOT" examples so it can't erode into a
   new "urgent" escape hatch. Nothing else, and NO config can add to it (only
   a code change reviewed at PR time). Even "I'm stuck, I need your call"
   stays quiet until you opt in — exactly what you said on June 13.
2. **One real tension needs your eyes (new since June 13):** the day AFTER
   you approved this design, we ratified a standard saying a genuinely-stuck
   promise I own should surface to you ONCE. This spec resolves it your
   June-13 way: stuck-promise notices stay QUIET (dashboard + unread badge +
   my own boot context + the digest), with a `commitment-deadletter` category
   you can opt into push anytime. Confirm that's still what you want.
3. **Which messages keep flowing as "part of the conversation"?** Default:
   only messages that answer a live action of yours — real replies, the
   unanswered-message receipt, "couldn't start your session", "your message
   was lost, resend", and direct responses to commands you typed. Each must
   cite the specific message of yours it serves; an active chat is not a
   standing license.
4. **The daily digest.** Default: OFF. If you turn it on, once a day you get
   one summary in the Attention topic — counts and category names plus your
   current opt-in list, never item contents. Purely opt-in.
5. **How fine-grained the opt-in is.** Default: per category ("reap notices",
   "quota alerts"), not per feature or per topic. Finer grain later if you
   want it.
6. **Where opted-in pushes land.** Default: the one Attention topic (Agent
   Health items keep their 🩺 topic). Never a new topic — already law.
7. **The push volume cap.** Default: 3 pushes per category per 10 minutes,
   overflow folds into one summary. Tunable down, never off.
8. **How long the quiet inbox remembers.** Default: 30 days / 20,000 entries,
   storm-proof (a repeating notice becomes one row with a count, so a bug
   can't wash out real history).
9. **Multi-machine opt-ins.** Default: one toggle applies everywhere — online
   machines immediately, offline machines get the change queued and applied
   when they return; if machines stay out of sync more than a day, you get
   ONE alert about it.
10. **Who flips enforcement on.** Default: YOU do, twice (dev first, then
    fleet), each time on presented evidence: 14 clean days, at least 200 real
    replies observed, and zero would-have-eaten-a-reply incidents. I present;
    you flip.
11. **Who can change opt-ins.** Default: only you — dashboard PIN or your
    explicit conversational yes, every change audited, bursts of changes
    alarmed. I can never grant myself push.
12. **The category list itself.** Default: the 18-category table printed in
    the spec ships as-is; your approval binds it. The dashboard tab is called
    "Notifications."
13. **The end-state of the old behavior.** June 13 you said remove the
    break-glass entirely. Default here: the off-switch EXISTS during rollout
    (dark → observe → enforce needs a lever; turning it off after the fleet
    flip warns you loudly about what it restores), and removing it entirely
    is the final cleanup increment after the fleet has soaked quiet —
    honoring your June-13 call as the end state, not skipping the staged
    rollout's safety.

## What this is NOT

- It does NOT touch your conversations with me — replies flow exactly as
  today, and every failure mode is biased toward delivering them.
- It does NOT replace the sentinels/watchdogs — they keep handling their real
  recovery cases; this governs what leaks through to YOU.
- It is NOT a new AI judgment call on the delivery path — the classification
  is deterministic provenance (where the message came from), no LLM, no text
  matching, nothing to misfire on wording.
- It does NOT ship live anywhere until you approve this spec — and the June-13
  "Approved" is recorded as design provenance only; this rebuilt artifact
  needs your fresh sign-off before any build starts.
