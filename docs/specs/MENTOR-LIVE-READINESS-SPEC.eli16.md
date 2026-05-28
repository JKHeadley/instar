# Mentor live-readiness — plain-English summary (for your approval)

## What this is, in one paragraph

The mentor's "user-hat" side now uses Telegram (your channel for talking to Codey), the
way you said it should. To make that work cleanly and reusably I'm also building a small
**building-block primitive** any two of my agents can use to talk over Telegram
*knowingly* — every agent-to-agent message carries a visible tag like
`[a2a:from=echo to=instar-codey role=mentor id=… corr=… ts=… v=1]`, the receiver checks
the sender is actually a known bot (not a human who typed the tag — real defense), and
the receive side has the anti-bounce machinery baked in (it knows not to send courtesy
replies, replies are tagged back with a matching id, etc.). The mentor is just its
first consumer.

## The live-readiness fixes (mentor)

*(There were three; you correctly cut one — the "is Codey free?" probe. A real user
doesn't check if someone's free before texting them; they just text, and the receiver
handles it. So that check is gone entirely. What's left:)*

1. **Talk to Codey via Telegram** — I mint a dedicated mentor bot (per your option C),
   message Codey from that bot in a dedicated Mentor topic on his setup, he processes
   it as a user-style prompt, replies tagged back, my Stage-B reads the reply. I don't
   pester: I won't send a new message while I'm still waiting on a reply to the last one
   (that's the real "user behavior" gate — not a status probe).
2. **Budget on real units** — I gate against your quota meter (5-hour / weekly) and a
   token ceiling, NOT pretend dollars. **Honest scope note**: today the ceiling only
   captures the Stage-B analysis spend; the spawned Stage-A session's tokens go to the
   ledger without a mentor tag, so they bypass the ceiling. I'm shipping the cap with
   the honest name (`stageBTokenCeiling`) and a tracked follow-up to bring Stage-A
   under the same cap — rather than claiming coverage I don't have.

## What round-1 file-based design got, and what the substrate change cost

The earlier file-based version is gone — Justin caught the substrate mistake and a
substantial amount of round-1 hardening (symlink defenses, schema versioning between
two files, cross-agent file writes, file-poll job on Codey's side) just drops out. In
exchange, the new substrate brings new concerns the reviewers caught:

- **The existing TelegramAdapter wasn't built for two bots in one process.** It writes
  state to fixed filenames; two bots would clobber each other. Fix: give the second bot
  its own namespaced sub-folder for its state, plus a flag to skip auto-creating a
  duplicate Lifeline topic.
- **The Adapter only allows one incoming-message handler at a time.** The "agent
  handler runs before normal user handling" rule needed a real implementation: I'm
  wrapping at the registration site so the agent-handler runs first and falls through
  to the existing user handler if the message isn't an agent message.
- **A real user could type the agent tag and trick the system.** Defense: the receive
  side checks the sender is actually a bot (Telegram's `is_bot` flag and the bot ID),
  not just trust the tag text. A user typing the tag gets dropped, audited, never
  routed to the mentor handler.
- **The "ping-pong" Justin worried about could come back slower.** If a single
  round-trip takes longer than my 15-minute tick, a naive next-tick would re-send.
  Fix: I track outstanding prompts; the tick refuses to send while one is in flight,
  and if it's still unanswered after 20 minutes I surface that as a degradation event
  + Attention queue entry. The same tracker tells me "Codey never replied" so silent
  reply-loss is observable.
- **A compromised Codey shouldn't be able to side-channel** by sending unexpected role
  types to my mentor bot. Fix: the accept-list is per-source — Codey-from-Echo's-
  perspective is allowed exactly one incoming role (`mentor-reply`) and nothing else.

## The honesty/learning thread

The earlier file-based draft was hardened across **two** convergence rounds before
Justin caught the substrate mistake. That was instructive: convergence reviewers ask
"is this design sound?" but not "is the framing correct?" — that's the user's call.
Recorded in memory as a durable lesson (`feedback_fix_at_the_right_level`). Also today:
when the spec cited a code line, it must be the line I actually read (one wrong line
number — 1327 vs the real 1592 — caught by a round-3 reviewer; corrected). Every spec
claim about a code surface now cites the line I verified.

## What's next after your nod

- I send Codey the final spec for confirmation on his side (small `/idle` endpoint + the
  receive-side handler + `sendAgentMessage` on his end — he agreed to all of this in
  round 2; only changes he might push back on are the round-3 additions I made today).
- I build my side through our normal gate. Codey builds his side in his repo.
- Both halves ship.
- Then we do **one supervised live cycle with you watching** — the actual test.
