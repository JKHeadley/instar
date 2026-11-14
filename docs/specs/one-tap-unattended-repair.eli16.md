# One tap turns on automatic sign-in repair everywhere — Plain-English Overview

> The one-line version: a new section on the dashboard's Accounts page lets the operator unlock once with the PIN, tick machines, and tap one button to switch on automatic sign-in repair for every account on those machines, with a second button to undo it.

## The problem in one breath

When a Claude or Codex account gets signed out, the agent can sign it back in by itself, but only on machines where that is switched on, and only for accounts on that machine's allow-list. Today the switch has no button, works on one machine at a time, and the lists are out of date (4, 6 and 3 accounts on three machines, one machine unread, one off), with nothing on screen saying so. On top of that, a second setting change after an update could be saved but never take effect, because its restart was counted like an update restart.

## What already exists

- **The on-switch for one machine** — a server route that changes the repair setting after a fresh dashboard PIN unlock.
- **Signed approvals between machines** — the machine the operator is using writes a short-lived, signed permission for one exact action on another machine; that machine checks the signature before acting. One-click repair of a single account already works this way.
- **The repair's own safety stops** — every repair checks that the account that signed in is the right person and quarantines it otherwise, stops after three failures in a day, has a capped number of attempts, and keeps asking forever for an account that ever signed in as the wrong person or from an unexpected place.

## What this adds

A section called "Automatic sign-in repair" on the dashboard's Accounts page. Each machine gets a row: what repair is set to there now, in plain words; the exact accounts that will be allowed (with any that would be dropped marked); how many accounts on that machine are not covered yet; and which accounts will still ask and why. The operator unlocks once, ticks machines, and taps "Turn on for ticked machines". Each row then shows a tick or a plain reason with a next step, and a re-check a little later confirms each machine took the change.

- Machines where repair already runs without asking start ticked, and the tap brings their account lists up to date. Since 2026-11-10 (Justin's rule that every action for the agent must work from any machine's dashboard), any other machine can be ticked too, whatever it is set to now, and switched on from whichever dashboard the operator has open. Those rows start unticked, so nothing changes on a machine the operator did not deliberately tick. The permission each machine receives carries, in its signed contents, the fact that the operator unlocked the dashboard with the PIN; without that, a machine still refuses to be switched on from elsewhere.
- "Switch ticked machines back to asking first" is the undo. It only works on machines that are currently running without asking, so it can never quietly switch repair on somewhere.
- When an account is added later, its machine's row shows it isn't covered, and the same tap covers it. The agent's instructions tell it to send the operator the card's link when that happens. The list never grows by itself.
- A machine that can't be read, or that runs an older Instar, says so and can't be ticked. It is never shown as "off".

## The new pieces

- **The setting on each machine's row** — added to a read the dashboard already does every 30 seconds, so no extra traffic. It shows only the repair setting and the machine's own verified account emails.
- **The one-tap sender** — on the machine the operator is using. It needs a fresh PIN unlock (the PIN typed into the request does not count here). For each ticked machine it writes a signed permission naming that machine, the exact setting, and the setting it expects to find there. It does the other machines first and its own last, because a change restarts the machine, and it answers within 90 seconds (a machine that hasn't finished by then shows "may have applied; checking again").
- **The receiver** — on each machine. It accepts "without asking" from another machine only when the signed permission says the operator had unlocked that dashboard with the PIN, and it applies the setting only if the permission is signed by one of the agent's own registered machines, is for this machine, hasn't expired or been used, matches the setting exactly, and the machine's current setting is still the one the operator saw. It refuses any account email this machine doesn't actually hold, and it can only switch between "without asking" and "asking first", never off.

## The safeguards

**Being honest about the PIN.** The PIN unlock is how the system knows a person is present, and the new button keeps that bar. But it is not a lock against the agent itself: the agent can read the PIN, and each machine's signing key sits on that machine. That has always been true of every PIN-protected action. Two weak spots in the existing repair routes were found and filed for their own fix: a PIN typed into the request with no limit on guesses, and any of the agent's machines being trusted to sign. The new pieces are built so that even a misbehaving signer can't do much: it can't add accounts a machine doesn't hold, can't rewrite a setting someone else just changed, and can't switch anything off.

**Old orders can't undo new ones.** Each permission names the setting it expects to find. A late "turn on" arriving after a "switch back" no longer matches and is refused, and the card refreshes.

**The repair's own stops stay.** "Turn on" for the machine you are on removes the "prove it ten times over thirty days" wait; a tap that reaches another machine only refreshes its account list and never lowers the wait its owner chose. The PIN is the same on every machine, so the person refreshing a list from one dashboard is the same person who set it up. What stays a per-machine choice is whether repair runs without asking at all. The card says plainly that even accounts never repaired on that machine will then repair without asking, and names any wait it removes. The identity check, quarantine, breaker and attempt cap still apply.

**Changes really take effect.** A setting change now asks for an ordinary restart, not an update-style one, so it can't be silently skipped, and the row says "restarting" until the machine has picked it up. If a machine stopped halfway, its row offers "Finish restarting", which only restarts and never changes the setting.

**Every change says where it came from.** Each machine's log records whether a change came from its own dashboard or from another machine, and which permission it used.

## What ships when

One change: the read, the sender, the receiver, the restart fix, the card, tests at all three levels, the agent-instructions update, and a note in the record of which settings must never be copied between machines. After it ships and the machines update, the operator gets one direct link to the card.

## What the reader needs to decide

Nothing beyond the original "Yes, go". The one judgment call made here is removing the waiting period on machines you tick, so repairs really start without asking. The card shows this before you tap.
