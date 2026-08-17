# Turning on the spending controls — in plain English

## What's broken

Instar can spend real money on paid AI services. Before it does, someone has to switch that
capability on, and then set limits on it. All of that machinery is built: there is a screen
for arming a paid service, a screen for setting a spending cap, and a change log recording
every adjustment.

There is one problem. All of it sits behind a master switch, and **nothing anywhere can
turn that switch on.** The screens are behind the switch, so the only thing an operator
ever sees is the "off" state. The ordinary settings route is deliberately blocked from
touching it — for a good reason, explained below. No command-line tool sets it either.

So the only way to switch it on today is to open a settings file on the machine and edit it
by hand. If you are on your phone, you cannot do it at all.

## Why the ordinary settings route is blocked

The obvious fix — "just let the normal settings route change it" — is the wrong one.

That route is authorised by a token the *agent* holds. If the switch were reachable that
way, the agent could grant itself permission to spend your money. The whole point of the
design is that the one who asks and the one who authorises must be different: the agent can
prepare a spending change, but only you, with your PIN, can approve it. Opening the settings
route would collapse that distinction. So the block stays, and the way in has to be built
properly instead.

## What this adds

A switch you can reach from your phone, behind your PIN.

You open the Spend tab, tap enable, and the server writes out exactly what is about to
happen in plain words. You read it, type your PIN, and it applies. Turning the layer on
**arms nothing** — every paid service stays refused, at zero spent, until you separately
arm it. Enabling is permission to use the arming screens, not permission to spend.

## The part that took ten rounds of review to get right

Switching the flag on is the easy half. The hard half is that the machinery which enforces
spending limits is built when the server starts, and only if the switch was already on. So
flipping the switch by itself gives you a screen that says "on" over machinery that is not
running. A button that reports success there is a button that lies.

The build therefore does the honest thing rather than the clever thing: it saves your
decision, tells you plainly that the layer comes up on the next restart and is **not
enforcing yet**, and gives you a "Restart now" button. The screen then watches until the
limits are genuinely up and enforcing, and says so only when it has checked. If the restart
does not complete, it tells you that instead of spinning forever.

It also checks the right thing. "Is the limit working?" is answered by deliberately
attempting a too-expensive test charge and confirming it gets refused — and specifically
confirming it was refused *because of the spending limit*, not for some unrelated reason.
A refusal for the wrong reason counts as a failure, not a pass.

That test charge goes through a **fake supplier** that is genuinely switched on but cannot
bill anything — it makes no call to anyone. An earlier version of this design instead sent
the test through a private side-door in the payment path, which the review process objected
to five separate times before an overall check singled it out as the biggest remaining risk.
It's gone. The test charge now takes the ordinary route like any other charge, so there is
no privileged path for anything to misuse, and two independent facts stop it costing money:
the fake supplier can't bill, and its limit is zero.

## The awkward bit, stated rather than hidden

There is a second, older way the layer can be switched on: a setting in the config file. If
that setting is on, then **turning the switch off will not stop spending.** Clearing the
switch cannot clear the config file — no route here is allowed to write to it, for the same
authority reason as above.

Rather than paper over that, the design leads with it. When the config setting is on, the
disable button makes you acknowledge that it will not stop spending, and the screen puts
**freeze** — which does stop it immediately — front and centre instead. A button labelled
"disable" that quietly leaves money flowing is a trap, no matter how well documented.

Similarly, "disable stops spending immediately" is true for new charges. A request already
sent to a provider is allowed to finish and **is** billed, because cancelling it halfway
would spend the money without recording it. The screen reports how many are still settling.

## About the "$100 a month"

The system can express two kinds of limit: a lifetime total, and a per-day rate. There is no
calendar-month limit in the model at all. You chose the daily rate for now, which works out
around $3.30/day.

Being straight about what that does and does not give you: it caps any single day, and over
a 30-day month the worst case lands near $100. It does **not** cap a calendar month, and it
will not stop a heavy fortnight followed by a quiet one. A real monthly limit is a bigger
change and remains available later — nothing here blocks it.

## What could go wrong

The honest headline risk is that this makes real spending easier to switch on. That is the
point of it, and the protections are: your PIN is required, every service stays disarmed
after enabling, freeze always works and is always cheap, and every action is written to a
log that cannot be edited afterwards.

The alternative — leaving it unreachable — has its own failure mode, which is you editing a
money-bearing settings file by hand while reading instructions off a phone screen.
