# Routing Control Room — Spend, Caps & Alerts — Plain-English Overview

> One line: a money dashboard for the agent's paid AI doors — see what you're
> spending, cap it (with a PIN), and get pinged when something runs away — built so
> the raw numbers can always be re-priced later if a price was wrong.

## The problem in one breath

The agent is about to start paying real money per token through some AI "doors"
(gemini-api, openrouter-api, groq-api). Right now there is a read-only map of which
door each job uses (that shipped already), but **nothing that tracks the money**: no
dollar total, no spending limit you can set, and no alert when a bill balloons or a
door dies. This feature adds all three.

## The idea, in layers

Think of it as a stack, and the trick is that **money is never written into the raw
record**:

1. **Ground truth = tokens + a timestamp.** We already log every AI call's token
   counts with an exact time. We keep doing that, untouched and append-only. We NEVER
   write a dollar amount into that log.
2. **A price book with history.** A separate, version-controlled file lists what each
   model costs per million tokens, *with dates* — "from July 1, GPT-5.5 cost $5 in /
   $30 out." If we later learn a price was wrong, we don't edit history — we add a
   correction with a date, and every dollar figure recomputes itself. That's why we
   store tokens, not dollars: dollars are always calculated fresh from tokens × the
   price that was true at that moment.
3. **Views = math on read.** Hourly / daily / monthly / total spend is computed live
   from tokens × price whenever you look — so a price fix instantly flows through.
4. **A money gate.** The one place that actually blocks a call at the cap uses a fast,
   never-cached counter that "fails closed" — if anything is uncertain, it refuses to
   spend rather than risk an overspend.

## Subsidies and credits

If a model is discounted for us, or we have $50 of free credits, that's recorded in
the *price* layer (a dated discount) or a small *credits* ledger — never by faking the
token counts. Gross cost, the credit, and net cost are all shown.

## Caps, alerts, and who's allowed to do what

- **Seeing** spend and caps: anyone the agent trusts (a normal read).
- **Stopping** spend (freeze a key): instant, no PIN — halting money is always cheap.
- **Raising** a cap or **turning a paid door on**: requires the dashboard **PIN** — a
  human-only action; the agent's own token can't do it.
- **Alerts** go to a dedicated Telegram topic when a cap is hit (or at 50% / 80%), a
  door goes fully dark, or a fallback door had to step in. It's built so a Slack
  channel can be added later without redoing the alerts. Alerts are polite: a door
  that dies but is instantly covered by a backup doesn't cry wolf — you only hear about
  a door when its whole backup chain is exhausted.

## Multi-machine safety

The agent can run on several machines that share one wallet. So the cap is sliced
across machines (each machine gets a portion, the portions add up to no more than the
total) — even if two machines can't talk, neither can blow the budget. The safe
default gives the whole cap to one machine until you opt into sharing.

## What ships when

- **First (dark, read-only):** the spend view and price book — shows "$0, no paid door
  live yet" honestly.
- **Then (PIN-gated):** the caps you can adjust and the switch that turns paid doors on.
- **Then:** the alerts.

Each part is reversible and independently switched, and nothing about the money can
happen until a human types the PIN.
