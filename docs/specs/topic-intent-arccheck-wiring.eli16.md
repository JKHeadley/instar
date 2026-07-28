# Wire ArcCheck — fix the surfacing gap (ELI16)

## What's broken

We built a three-layer "topical memory" for the agent:

- **Layer 1 — capture**: writes down what each topic is about, turn by turn. ✅ Live.
- **Layer 2 — briefing**: at the start of each session, hands the agent the
  current cliff-notes for the topic ("here's what we already decided, here's
  what we're working on"). ✅ Live.
- **Layer 3 — ArcCheck**: before the agent sends a reply, checks the draft
  against those cliff-notes and waves a flag if the draft contradicts a
  decided item or acts on something that isn't actually decided yet.
  ❌ **Built but unplugged.**

ArcCheck is unplugged in two ways:
1. The "brain" that compares the draft to the cliff-notes was never connected
   to the box that holds it. The box exists; when you ask it for an answer
   it shrugs and says "no brain configured."
2. Even if the brain were connected, nothing actually asks the box anything
   before sending a reply.

## How we caught it

Last conversation in the parent topic, the agent said *"we eventually need a
second machine for the cross-machine test."* The cliff-notes for that topic
already had, in the **decided** section: *"the Mac mini is already set up
and reachable over SSH."* The data was right there. ArcCheck should have
waved a flag — *"hey, you're contradicting a settled fact about the mini."*
It didn't, because it can't. The wire isn't there.

## The fix

Two small changes:

- **Plug the brain in.** Build the comparison function (same shape as the
  capture function we already shipped) and pass it into the box at server
  startup. Now when you ask the box, it actually thinks instead of
  shrugging.
- **Ask the box.** Before sending an outbound reply, ask ArcCheck for a
  verdict. If it fires, hand the verdict to the existing tone-and-coherence
  gate as one more signal — same channel the other signal-emitters use. The
  gate already exists; we're just adding one more input wire.

Everything stays **signal-only**: ArcCheck can wave a flag, but it cannot
block a send. The existing gate is still in charge. The flag includes a
suggested rewrite hint the gate can fold in or ignore.

## Why this is small

- The comparison function and the gate it plugs into both exist already —
  we wired them with the capture-loop work.
- The route ArcCheck answers on already exists and already increments two
  counters (`arccheck_fired`, `arccheck_signalled`) that have been waiting
  to become non-zero.
- No hook, template, skill, or settings file changes. Server-side only.

## How we'll know it worked

We'll write the actual mac-mini drift as an end-to-end test:

1. Set up a topic with one decided fact: "the mini is already configured."
2. Draft a reply that contradicts it ("we need a second machine").
3. Assert ArcCheck fires `contradicts-settled` with the rewrite hint.
4. Assert the gate sees the signal.
5. Assert the message still delivers.

When that test goes green, the gap is closed.

## What this does NOT fix (on purpose)

- **Old briefings.** The cliff-notes are handed to the agent at session
  start, but never refreshed mid-session. In long sessions they age out.
  Fixing that is a separate piece — when to refresh, what to spend on it,
  how to merge it in. ArcCheck doesn't depend on it: ArcCheck reads the
  fresh store directly, not the cached briefing.
- **Capture failure rate.** A side finding showed ~47% of capture attempts
  on the parent topic fail with `cap_or_error` (likely budget shedding).
  Tracking it separately; doesn't change ArcCheck's design.

## In one sentence

Plug the unplugged comparison-and-flag layer back into the outbound path, so
that when the agent's about to contradict something the topic already
decided, the existing gate sees a flag instead of nothing.
