# Plain-English overview — a refused tunnel must not report itself healthy

## What this is about

Your agent runs on a machine in your house. To let you reach it from your phone —
to open a private view, or a secure form to hand over a password — it opens a
"tunnel": a temporary public web address that points at your machine.

Instar's default tunnel comes from Cloudflare, free and instant. You ask for one,
and Cloudflare hands back an address like
`https://brave-lion-rapid-meadow.trycloudflare.com`. Anything sent to that address
arrives at your agent.

## What was going wrong

Cloudflare limits how many of these free tunnels you can open in a short period.
When you hit that limit, it refuses — and the tool Instar uses to talk to
Cloudflare handed back, instead of a real address, **the address of Cloudflare's
own API**: `https://api.trycloudflare.com`.

That is not a tunnel. It is the front desk Instar was talking to in order to ask
for one. Sending a request there gets an error, not your agent.

Instar accepted it anyway. It had asked for an address, it got something that
looked like an address, and it recorded it as the tunnel. From that moment the
agent believed it had a working tunnel. If you had asked it, it would have told
you so: the tunnel status read `active`.

## Why that mattered more than it sounds

Every link the agent builds for you is built on that address. On 21 October 2026
two in a row were handed to the operator on that dead host. One was a page of
research. **The other was a secure form asking for a payment card.**

So the operator would have tapped a link, got an error page, and had no way to
know whether the problem was the link, the form, their phone, or their agent. The
one thing they could not have known is the true answer: the tunnel had been
refused forty minutes earlier and the agent never noticed.

Worse, the agent's own status display agreed it was fine. It reported `active`
while simultaneously recording, one field away, that the last attempt had been
rate-limited. Both facts were true; nothing compared them.

## What changes

Before accepting an address as a tunnel, Instar now checks it actually looks like
one: secure (`https`), ending in `.trycloudflare.com`, with exactly one name in
front — and specifically **not** `api`, which is the front desk.

If the address fails that check, Instar treats the tunnel as failed, which it
genuinely is. That is not a new behaviour: Instar already knows how to handle a
refused tunnel — it waits, backs off, retries, and can fall back to another route.
The bug was never the handling. It was that a refusal was being recorded as a
success, so the handling never ran.

## What this does not claim

It checks the **shape** of the address, not that the address works. A tunnel that
is correctly formed but has since died will still pass this check. Catching that
would mean making a network call every time a tunnel starts, which costs time on
every startup to catch a case the existing disconnect handling already covers. The
fix is deliberately narrow: the specific, observed way a refusal was being
mistaken for a success.

## The safeguards, plainly

- It cannot reject a working tunnel. Every real Cloudflare quick-tunnel address
  has the shape it accepts.
- It cannot be fooled by a look-alike. `evil-trycloudflare.com` and
  `trycloudflare.com.attacker.test` are both refused, and there are tests for
  exactly those.
- Rejecting is the safe direction. The worst case if Cloudflare ever changed their
  address format is that quick tunnels stop being accepted and say so loudly —
  rather than appearing to work while silently going nowhere.
- Backing it out is one file. No stored data changes, no settings, no migration.

## What a reader has to decide

Only whether "shape, not reachability" is the right line to draw. The argument for
it is that the observed failure was a malformed address, the handling for an
unreachable one already exists, and a startup network probe costs every agent time
on every boot to catch a case already covered.
