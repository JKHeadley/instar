# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Spend tab gains the screen for arming a paid door — setting its spending limits and taking
it live. The machinery for this existed and worked; the screen did not, and the tab's own small
print said caps and go-live were "a later increment". So an operator told arming was "one tap,
enter your PIN" went looking for a PIN box that had never been drawn. That copy is corrected too.

## What to Tell Your User

- "You can now set a paid door's limits and turn it on from the Spend tab, on your phone."
- "It asks for your PIN twice on purpose — once to set the limits, once to start spending."
- "The freeze button needs no PIN. Stopping money should always be immediate."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Set a paid door's ceilings | Spend tab → Paid doors → enter both ceilings → Preview → PIN |
| Take a paid door live | Spend tab → Paid doors → Preview go live → PIN |
| Freeze a door immediately | Spend tab → Paid doors → Freeze (no PIN) |

## Compatibility Notes

**The controls cannot arm anything until the money layer is switched on, and that switch is
reserved to the operator** — deliberately not something an agent or a developer can flip. Used
while it is off, the screen says exactly that, rather than showing a generic error that would
send someone hunting for a mistake they did not make.

**Both ceilings are required.** A door has a lifetime ceiling and a daily ceiling, and there is
no monthly setting, so a monthly intention must be expressed as both. The screen refuses a blank
rather than choosing one silently: $100 lifetime with $3.30/day is a hard budget that also cannot
burn in an afternoon, while $3.30/day with a large lifetime is a tap left running.

**You approve rendered words, not a button.** The server writes out what it is about to do and
the screen shows that sentence before the PIN box appears. What commits is that plan, not the
form — so editing a number after previewing invalidates the approval, and a figure never read
cannot land.

## Evidence

31 unit tests against the shipped module in a real DOM, plus wiring tests asserting that every
dashboard module the page imports exists on disk — the guard against the "built but unreachable"
shape this feature is fixing.

Shown capable of failing, independently: leaking the PIN into the preview request fails exactly
the security test; replacing the honest switched-off message with a generic one fails exactly the
two tests pinning it. A control asserts an ordinary network failure does not claim the money layer
is off.

Not yet proven live: the money layer is off on this agent, so the end-to-end arming path cannot be
exercised until an operator enables it. That is stated rather than implied away.
