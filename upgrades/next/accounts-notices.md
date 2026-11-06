<!-- bump: patch -->

## What Changed

The top of the Accounts screen, on the phone and on the dashboard, now shows a notice only when something needs the person or changes what they can do. It used to always show a summary line, such as "SageMind - Adriana is nearly out; others have room.", which was routine and could be wrong: in the reported case two accounts were at 100%, not one "nearly out".

The phone read (`GET /mobile/accounts`) now carries `notices`, each with its action. A notice appears when a machine has no signed-in account and a sign-in would fix it, when accounts need signing in that no machine notice covers, when every usable account, or every usable account of one kind (Claude, Codex), is at or over 90% (with when room returns), or when this machine's own account list can't be read. One account full while others have room is on its row and is no longer a message. The dashboard's Accounts page uses the same rules: its title is "Accounts" unless a sign-in needs you, notices sit under it with a Sign in link or "Ask the agent about this", and the routine "at 90% or more" line is gone. The `headline` field stays for app builds that already show it, and no longer names one account as nearly out.

## What to Tell Your User

The top of your Accounts screen is now only for things that matter: a machine with nothing signed in, or all your accounts (or all of one kind) running out, with when room comes back. Each one has a button to fix it or ask me about it. When nothing needs you, it stays empty, and the account list shows how full each one is.

## Summary of New Capabilities

The Accounts screen has a notice spot that is empty unless a machine has no signed-in account, accounts need signing in, the whole pool or one kind of account is nearly out, or the list can't be read. Each notice has its own action.

## Evidence

Justin's screenshot on 2026-11-06 at 14:17 PST, topic 134088, showed "SageMind - Adriana is nearly out; others have room." while Adriana and Echo were both at 100% and Dawn and Luna had room. Unit tests cover that exact case (no notice, headline "2 of 4 accounts have room."), and each notice rule on both sides, on the server and in the dashboard model. A route test covers the phone read, and jsdom tests render the dashboard page with and without notices. Simulator screenshots of the app branch with sample data show the empty spot, an out-of-room notice and a machine notice. Not yet seen on a live screen; that check follows the release.
