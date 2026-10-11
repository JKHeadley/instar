# Telegram replies from a non-lease machine are forwarded, never silently held

<!-- bump: patch -->

## What Changed

When the agent runs on more than one machine, a reply authored on a machine
that holds the bot token but not the serving lease used to be refused by the
local destination check and parked in memory: no send, no notice, lost on
restart. That machine now forwards the sealed reply to the lease holder over
the existing signed origin mesh, and the holder runs the same lease check the
direct path runs (it used to execute forwarded operations unchecked). The
reply request re-reads the lease for up to 15 seconds, then makes one forward
attempt; any failure becomes a durable hold with the new reason
`lease-not-held` (the existing `destination-not-authorized` still means a
foreign chat and is never forwarded). The fixed notice "I have your message;
my reply is delayed while it is routed through <holder>" goes out through the
holder, and one attention item is raised (three held topics on one machine
within an hour collapse to one). Recovery re-forwards the same operation at
+10 s and +20 s from the origin tick, then on the existing 15-minute schedule;
an attempt the holder never confirmed is resolved at that holder's receipt,
never re-sent blind; after a lease move the old record is superseded and a new
one bound to the new holder lands once. A hold that reaches its 6-hour
deadline is reported once with honest wording. `/health` carries
`telegramOrigin.heldForward`, and the origin status lists held rows with their
reason. The forward is switchable per agent
(`messaging[].config.messageOrigin.forwardToHolder.enabled`, default on, read
live); the durable held state, its reason and the notice are not. Single-machine
agents are unaffected.

A latent recovery bug is fixed on the way: the store rebuilt a replayed
operation with an empty `allowedDerivations` array the sealed original omits,
so every store-replayed forward failed the holder's seal check.

## What to Tell Your User

If you run me on more than one machine, a reply I write on a machine that is
not currently in charge of Telegram now reaches you through the machine that
is, instead of vanishing. If it cannot be handed over, I tell you it is delayed
and keep retrying; you see the held reply listed on the Message origins page
and in your attention hub. Nothing changes on a single machine.

## Summary of New Capabilities

- Non-lease machines forward Telegram replies to the lease holder.
- Failed forwards are held durably with a named reason, reported once, and retried.
- A lease move supersedes the old record and delivers once via the new holder.

## Evidence

Unit tests cover the settling states, the one-attempt request, the ladder
state, same-operation re-forward, receipt-first on an unconfirmed attempt,
supersede on a holder change, item collapse, expiry wording, the config
switch and migration, the durable store rows, and the adapter send decision.
Integration tests drive a standby and a holder over the real signed mesh HTTP
pipeline with real stores and routes: the reply lands via the holder, a
`not-lease-holder` refusal is retried once by the ladder and lands once, a
lease move supersedes and lands once, a dark holder yields the 409 and the
status/health listing and is delivered once when it returns, and the notice
goes through the holder. The E2E test boots the production origin path and
shows the feature alive, the hold durable across a restart, and the migration
landing once. The self-action ratchet proves the retry ladder settles.
