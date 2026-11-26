# Feature switches that actually switch — plain-English overview

## What is wrong today

The dashboard has a Features page with an on/off switch for each optional capability:
talking to other agents (Threadline), publishing pages, the internet tunnel, backups,
and so on. Each feature also knows exactly which setting in the agent's config file it
needs changed to really turn on or off.

When the operator flips a switch, the server writes down "the operator wants this on"
and stops there. The setting is never changed, so the agent keeps not doing the thing.
Then, at the next restart, the server notices the setting is still off and quietly
moves the switch back to off. The dashboard said "On" for a while, and nothing ever
happened.

It is worse than that for most features: nine of the thirteen are marked as sending
data off the machine, and those insist on a written consent record before they can be
switched on. The dashboard never sends one, and the switch's state machine was built
for the agent suggesting features to a person, not for a person flipping a switch. So
for most features the switch just shows an error.

## What already exists

- Every feature definition names its "turn on" and "turn off" request.
- The config routes that request goes to already check what may be changed (some
  settings, such as which program a session runs, are deliberately off limits).
- The dashboard already has a proof that a real person recently entered the PIN
  (the "operator session"), used by other sensitive buttons.

## What is new

1. **The switch now changes the setting.** When the switch moves, the server sends the
   feature's own turn-on or turn-off request to itself, through the same route anyone
   would use, so every existing safety check still applies. Only four exact requests
   can ever be sent (the two settings routes and the two telemetry routes); the client
   refuses anything else. The answer comes back with the switch result: applied,
   refused (with the reason), or failed. Two switches for the same feature at once are
   handled one after the other, so an old "off" can never land after a newer "on".
2. **The result is remembered** on the feature, so a refused change stays visible even
   after a restart has reset the switch.
3. **The page tells the truth.** Each feature now reports three facts: what the switch
   says, what the setting says now, and what the setting was when the agent last
   started. From those it gives one plain sentence, such as "On (the setting was on
   when the agent started; running is not separately verified)", "Saved as on; it may
   not start until the next restart", or "Switched on, but the setting is still off:
   <reason>". Where something outside the setting can override it (Threadline's
   environment variable), the sentence says that too. It never claims "running" for something only just saved, never invents a
   start-up state it did not record. The evolution system, whose setting this version ignores, is shown as a
   read-only switch with a plain note instead of a switch that pretends to work.
4. **A person flipping the switch counts as consent.** Before turning on a feature that
   shares data or acts on its own, the page shows what it does and what it shares;
   the switch then goes straight to on or off from any state, with the fresh PIN proof,
   and the consent record is written. The PIN is asked for only when that proof is
   missing or no longer valid (after a page reload, or after 15 minutes; the server
   says so plainly rather than quietly failing). Without the proof (an agent acting
   alone), all the old rules still apply.
5. **Four definitions were wrong and are fixed.** Threadline's switch wrote a setting
   nothing read (`threadline.enabled`; the relay reads `relayEnabled`). Autonomous
   Evolution wrote `autoImplement`, which nothing reads (it runs on `approvalMode`).
   Six features that run unless explicitly turned off (publishing, the tunnel, backups,
   the file viewer, input guard, external operations) were shown as off whenever the
   setting was simply absent. The tunnel's turn-on request would have replaced a named
   tunnel with a temporary one.
6. **The file viewer's settings route now exists even when the viewer started
   switched off**, so its switch can turn it on (and it takes effect without a restart).

## Safeguards

- The request that gets sent comes only from the feature's definition in code; nothing
  a caller sends can change what is requested or where, and only four exact requests
  are ever possible.
- Going through the existing route means nothing can be changed that the route itself
  would refuse. A refused change is shown with the route's own reason.
- Only the main operator's switch changes the agent's settings; another user's switch
  is recorded but not applied, because settings are agent-wide. (That is a courtesy
  rule, not a security boundary: the user id is chosen by the caller.)
- If a change is refused, the switch's position is kept and the refusal is shown,
  rather than pretending nothing happened.
- Undoing this change is a plain revert; the one new stored field is ignored by older
  versions.

## What a reader needs to decide

Almost nothing new is being allowed: anyone with the agent's access key could already
send the setting change directly. The one exception: the file viewer's settings route
is now reachable while the viewer is switched off, so that same access key can turn the
viewer on without a restart (the same route, checks and header as when it is on). The
decisions are whether the switch should do what it says (yes), and whether a fresh PIN
unlock is good enough proof of consent for a person flipping a switch (it is the same
proof other sensitive dashboard buttons rely on). One feature, the evolution system, is
shown read-only, because this version of the agent ignores its setting: a switch that
looked like it worked would be the original bug again.
