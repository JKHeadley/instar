# Routing Control Room — Spend, Caps & Alerts — Plain-English Overview

> One line: a money dashboard for the agent's paid AI doors — see what you're
> spending, cap it (with a PIN), and get pinged when something runs away — built so
> the raw numbers can always be re-priced later if a price was wrong, and so the thing
> that actually blocks spending can never be fooled into overspending.

## The problem in one breath

The agent is about to start paying real money per token through some AI "doors"
(gemini-api, openrouter-api, groq-api). Right now there is a read-only map of which
door each job uses (that shipped already), but **nothing that tracks the money**: no
dollar total, no spending limit you can set, and no alert when a bill balloons or a
door dies. This feature adds all three.

## The one big idea: two separate books

The most important design choice is that there are **two separate sets of books**, and
they are kept apart on purpose:

1. **The REPORTING book** answers *"what did we spend?"* It is built from tokens (which
   we already log) times a price list. If we later learn a price was wrong, we add a
   dated correction and every dollar figure recomputes itself. This book is allowed to
   be a little incomplete (a dropped log line here or there), because it's just for
   looking at — it never blocks anything.
2. **The MONEY book** answers *"is this call allowed to spend?"* It is a brand-new,
   careful ledger that the spending gate reads. It is written in a fail-safe way (if it
   can't be saved, the call is refused) and it is **never re-priced** — it records what
   was actually committed at the moment of the call. This is the book that enforces
   your cap.

The first review round found that the original draft tried to make ONE book do both
jobs — and that the "just rebuild the money number from the token log" idea could
quietly *lower* your spending counter after a price correction, re-opening a cap you
had set. Splitting the books fixes that.

## Layers, plainly

1. **Ground truth = tokens + a timestamp.** We already log every AI call's token counts
   with an exact time. We keep doing that, untouched and append-only. We NEVER write a
   dollar amount into that log.
2. **A price book with history.** A version-controlled file lists what each model costs
   per million tokens, *with dates* — and only prices a human has reviewed are allowed
   to affect the actual spending gate. An automatic price-checker writes what it sees
   into a separate "observed" scratch file that structurally cannot touch the gate; you
   promote an observed price into the real book with your PIN (or a reviewed commit).
   Price changes always take effect at a day boundary — that one rule keeps the daily
   math exact for the whole history without keeping years of raw logs.
3. **Views = math on read.** Hourly / daily / monthly / total spend is computed from a
   small daily token summary times the price — so a price fix instantly flows through,
   and we never have to keep years of raw log rows or freeze the server crunching a
   giant query.
4. **A money gate.** The one place that blocks a call at the cap uses a fast,
   never-cached counter that "fails closed" — if anything is uncertain (missing price,
   an implausibly cheap price, a frozen key), it refuses to spend. Importantly, hitting
   a dollar cap doesn't kill the job — it just steps over to the next (often free) door,
   exactly like a door that went dark.

## Grounding on the provider's own numbers

The operator asked for one more thing: wherever possible, trust the **provider's own
report** of what a call cost, not just our own tokens-times-a-price-list math. So the
*reporting* book now prefers the provider's figure whenever the provider gives one —
captured as its own dated, never-edited record — and falls back to our own math only
when it doesn't.

Being honest, the three paid doors report very different things:
- **OpenRouter** hands back the actual dollar cost of each call right in the response
  (plus a follow-up endpoint with the exact cost, and an account-balance check). That's
  the strongest case — we use OpenRouter's own cost figure.
- **Groq** and **Gemini** report exact *token counts* per call, but **not** a dollar
  cost. So for those we still compute the cost ourselves — but from the provider's true
  token counts, which is better than our estimate. Gemini's dollar figures only exist in
  a heavy, slow billing export, so that's a later add-on.

Every paid call gets one internal receipt number, and the provider's report is matched
to exactly that call by it — so a late-arriving provider figure updates the right call
and can never be double-counted. A background **reconciliation** check compares "what
we thought we spent" against "what the provider says we spent," per door, and flags
any meaningful gap. If the provider
says a call was *cheaper*, the report shows the cheaper number — but it never loosens
your cap (that would re-open spending you'd committed). If the provider says it was
*more expensive*, that's a signal your price list is stale — it raises an alert and
nudges you to update the price the gate uses going forward. Crucially, **none of these
provider numbers ever touch the actual spending gate** — the gate can't wait on a
provider's website, so it keeps using its own fast, fail-safe math. Provider reporting
makes the *view* truer; it never changes what blocks a call.

## Subsidies and credits

If a model is discounted for us, or we have $50 of free credits, that's shown in the
*reporting* book only — it makes the report rosier, but it can **never** loosen the
actual cap. A per-operator deal lives in a small local file, not the shared price list,
so it doesn't leak onto other machines.

## Caps, alerts, and who's allowed to do what

- **Seeing** spend and caps: anyone the agent trusts (a normal read).
- **Stopping** spend (freeze a key): instant, no PIN — halting money is always cheap.
- **Raising** a cap or **turning a paid door on**: requires the dashboard **PIN**, from
  a proper phone-friendly form that shows a plain-English "arm this door at $X/day —
  approve?" plan. What you approve is exactly what applies: the server lists EVERY
  field it will change, and anything not shown in that plan is rejected outright — a
  request can't smuggle a hidden cap raise past your approval. The agent's own token
  can't do any of it, and it deliberately can't be done by quietly patching a config
  file either.
- **Alerts** all go to **ONE dedicated Telegram topic — "💰 Routing & Spend Alerts" —
  never a scatter of topics.** A cap being hit (or at 50% / 80% of the daily AND
  lifetime cap), a door going fully dark, fallback usage spiking, a price looking
  stale, or the provider's own numbers disagreeing with ours all land in that same one
  place. The topic is found by a saved id (not by guessing at its name), and created
  only if it doesn't already exist — with a guard so two machines can never
  accidentally make two copies of it: only the one machine currently "in charge" ever
  creates it, it makes it exactly once, and the saved id is shared to the other
  machines, so even a later handover of which machine is in charge reuses the same
  topic instead of minting a new one. Money-critical alerts are also sent the durable
  way (retried until they actually arrive), so a network blip can't swallow a "you hit
  your cap" message. It's built so Slack can be added later without redoing the
  alerts. Alerts are polite: a door that dies but is instantly covered by a backup
  doesn't cry wolf — you only hear about a door when its whole backup chain is
  exhausted, and routine "the backup stepped in" churn is just logged, never pinged. And
  a money alert is never dropped just because the topic isn't set up yet — it falls back
  to your lifeline.

## Multi-machine safety

The agent can run on several machines that share one wallet. **The first live money
release deliberately keeps it simple: the whole budget lives on ONE machine you
designate** — other machines can't spend at all, and every machine's dashboard shows
the real number by asking that machine (never a misleading local "$0"). If the money
machine dies, spending freezes (the safe direction), a *surviving* machine tells you,
and you reclaim it from the dashboard with your PIN — never an automatic grab.

Sharing the budget across machines is a later, separately-switched increment with
strict rules already decided: slices track **dollars actually burned**, not just "how
much is handed out," so a machine can't spend its slice, hand it back, and get the same
money re-issued; and each machine re-checks it still holds a valid slice on *every*
call, so a machine cut off from the group can't keep spending on a stale copy.

## An honesty note about scope

The paid doors don't actually route yet — that's separate in-progress plumbing (the
"nature-routing enforcement" work and the paid-provider code). So this feature ships
its spend *view* first, showing an honest "$0, no paid door live yet," and the money
*gate* wires into the paid-call path when that path exists. This spec is upfront that
per-door money tracking depends on that other work landing.

## What ships when

- **First (dev-agent on, dark on the fleet, read-only):** the spend view and price book
  — shows "$0, no paid door live yet" honestly.
- **Then (PIN-gated, the documented money exception):** the caps you can adjust and the
  switch that turns paid doors on — single-machine money only. This step also brings
  the first two alerts (a stale price / a price drifting from reality, since those
  affect what the gate charges) and, with them, the machinery that finds-or-creates
  the one alerts topic.
- **Then (dry-run first):** the rest of the alerts.
- **Last (dark until proven):** sharing the budget across machines.

Each part is reversible and independently switched, and nothing about the money can
happen until a human types the PIN.

## Status update (2026-07-08)

The operator approved this design conversationally on 2026-07-07 (topic 29723) and the money
increment (Increment B) is now built: the spending ledger, the fail-closed cap gate, the
PIN-approved plan flow for raising caps / arming doors, and the instant freeze button. It all
ships switched OFF for everyone — turning the money layer on is an explicit operator action,
and even then every paid door stays off until you arm it with your PIN, one by one.
Constitutional anchor: "Token-Audit Completeness — An Unmetered LLM Call Is an Unaccountable One."
