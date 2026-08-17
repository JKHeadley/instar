---
user_announcement:
  - audience: user
    maturity: experimental
  - audience: user
    maturity: stable
---

## What Changed

Two dashboard fixes from one operator report: *"I need TWO THINGS: 1) the ability to
enable doors and set a spend cap on the dashboard, 2) the Subscriptions page to clearly
group/distinguish different providers."*

**1. The spending-control switch now has a screen.** The previous release shipped six
pre-gate routes and the honest limit *"no dashboard form yet — the routes are
phone-reachable and the agent drives them, but a form the operator taps unaided is not
built."* That closed the config-file complaint on paper while leaving the operator exactly
where they started: a Spend tab whose every control answered 503, and nothing on screen to
change it. This is the form.

It sits at the TOP of the Spend tab — above the read-only spend view and the arming
controls — because every one of those is gated on this switch, and a switch rendered
*below* the thing it enables disappears inside the very 503 it exists to fix. The load
order is pinned by a test rather than by a comment.

The flow is the spec's, with nothing added: the plain-English state → **Turn on spending
controls** → the server's own approval wording, shown verbatim → the dashboard PIN →
the restart step (its confirmation text also verbatim, hashed over the text that was
actually displayed) → then the panel polls until the *status route* says the controls are
enforcing. The restart response is never treated as proof; only the poll is.

Three honesty properties are carried into the copy rather than left to the reader:

- **On is not spending.** Turning it on arms no paid service — every door stays refused at
  `$0` until separately armed. The panel says so in the same breath as "enforcing".
- **Switched on is not enforcing.** The layer is built when the server starts, so an enable
  that only registered intent routes the operator to the restart, never to "done".
- **Off may not be off.** When a config-file setting is what enables the layer, clearing
  the operator's own setting does **not** stop spending — the panel refuses to present that
  as success and points at the emergency freeze, which is instant and always available.

No lifecycle enum value is ever rendered to the operator; the copy is derived and
tested against the internal names leaking.

**2. The subscriptions grid groups by provider.** The account *cards* already grouped —
a Claude heading and a Codex heading. The account × machine *grid* underneath, which is
the surface an operator with several accounts actually reads, did not: seven rows of
account names with nothing telling the providers apart. It now carries a provider band,
reusing the cards' own grouping so the two surfaces cannot drift — same first-appearance
order, and still **no** band at all on a single-provider install.

## What to Tell Your User

If you asked to set spending limits from your phone and were told to edit a file on the
machine — that's fixed. Open the dashboard, go to Spend, and the switch is the first thing
on the page with your options laid out. You approve the exact wording the server shows you
with your dashboard PIN, confirm the restart it asks for, and the page tells you when the
controls are genuinely up rather than just switched on.

Two things worth knowing. Turning it on starts **no** spending — every paid service stays
refused until you separately arm it with a limit. And turning it **off** clears only your
own setting: if something in the config file on the machine is also turning it on, the page
will say plainly that this did not stop spending and point you at the freeze button, which
stops it immediately.

Separately, if you have accounts with more than one provider, the Subscriptions grid now
shows which rows are Claude and which are Codex instead of running them together.

⚗️ **Experimental** applies to the spending controls themselves, not to this screen — no
paid service is live yet, so there is nothing to spend until you deliberately arm one.

## Summary of New Capabilities

- Turn the spending controls on (and off) from the dashboard on your phone, with your PIN —
  no config file, no terminal.
- The screen distinguishes *switched on* from *actually enforcing*, and walks you through
  the restart that closes the gap.
- A disable that cannot stop spending is reported as exactly that, with freeze offered
  instead of a false success.
- The Subscriptions account × machine grid labels its provider groups.

## Evidence

- **121 tests** — 30 unit over the new module's pure functions and renderers, 18 wiring
  tests asserting the page actually mounts and imports it (a module nothing imports is the
  defect this release fixes, wearing a green tick), and 73 over the subscriptions
  renderers including 7 new ones for the grid grouping.
- **Mutation-checked, not just green:** reverting the grid grouping fails exactly 3 of the
  new tests and nothing else; reverting the commit-outcome ordering fails exactly the test
  that found it.
- **Driven live against the running agent server** (v1.3.1176, money layer `disabled`):
  the status route answered and the panel rendered *"Spending controls are off"* with its
  one button; the button's plan call returned the server's real wording; the approval box's
  text was asserted byte-identical to the server's, not eyeballed; a commit with a wrong
  PIN was refused `401 bad-pin` and a re-read showed the state unchanged.
- **One real defect found by writing the tests:** the function deciding what the operator
  must do next reported a store-only disable under a config enable as *"done"*, because it
  asked what the layer currently IS before asking what the operator's action DID. That is
  precisely the *"I disabled it and it is still on"* misreading the whole surface exists to
  prevent, reproduced in the one function meant to prevent it. Fixed, with the ordering and
  its reason recorded in the code and pinned by a test.

## Known Limits

- **Setting a cap and taking a door live are still the arming panel's job**, below the
  switch. This release makes that panel reachable — it was previously behind a switch with
  no on-position — but does not redesign it.
- **The restart step needs a secure page.** Approving a restart hashes the confirmation
  text in the browser, which needs `https` or `localhost`. On a plain `http://<LAN-IP>`
  dashboard the panel refuses that one step and names the remedy rather than sending an
  unbindable request.
- **Single-machine, by design.** The money layer is single-writer until Increment D, so the
  switch governs the machine whose server answers the dashboard; the panel names that
  machine so it is never ambiguous.
