# Two machines stop restarting each other

## What was wrong

When an agent runs on two machines, a "lease" says which machine is in charge. On a pair with no shared git remote, each machine keeps only its own copy of the lease in a local file. That file does not record what the other machine has done since.

So a machine that had just restarted read its own old copy, saw it had expired, and took the lease with the next number. It never asked the other machine, which was up and already holding the lease, often with that same number. Now both were in charge at the same number. The tie-break picked a loser, and the loser's change of role made it restart once. That restart set up the next tie.

On our two test servers this went on for a day and a half, one restart every 15 minutes on each machine. 15 minutes is only the limit on how often a role change may restart a machine, so the limit set the speed and did not stop the loop.

## What changes

- A machine that keeps only its own copy of the lease now asks the other machine before it claims, whether its copy is expired or missing. The ask takes at most 10 seconds. If the other machine holds a live lease, this machine stays on standby, so no tie happens and no restart follows.
- If the other machine's lease has the very same number as this machine's expired copy, the other machine's lease now counts as the current one. The old copy used to win that comparison, so the machine kept naming itself as holder, claimed over a live lease, and handed its dead copy to the real holder, which could read it as a tie and step down.
- An expired lease from the other machine no longer counts as a tie.
- A machine on such a pair now always renews the lease it holds. Before, only agents with Telegram or app conversations did this. On any other agent, Slack ones included, the lease ran out between checks, the other machine took it, and each swap restarted a machine. In a 15-minute simulated run that was 15 swaps, and now it is none. An explicit setting that turns renewal off still wins.
- When the other machine asks for the lease over its signed connection, the holder now counts that as proof the link works and extends its lease. This matters because a restarting machine starts asking within seconds but can take minutes before it can receive anything. Before, the holder could not reach it during those minutes, so its lease ran out, and the booting machine took it. That was another way round the same loop. A machine that is really gone asks nothing, so its partner's lease still runs out as it did.
- A machine that may not hold the lease because its identity is not set up now gives it up even while renewal keeps running. That rule existed but only ran for a machine trying to claim.

## What stays the same

If nobody answers within 10 seconds, the machine claims the lease as before, so a real takeover still works when the other machine is down. Only the wait is new, and only when no answer comes. Pairs with a shared git remote already settle this through git, so none of these changes apply to them except the expired-lease rule. A single machine behaves as it did, apart from keeping its lease steadily. A pool with a named main machine does not ask before claiming, as before, but it does get the renewal and the other rules above when it has no shared remote. The restart limit and the tie-break are unchanged.

## Safeguards

Asking only reads, and a lease with a bad signature or a released lease proves nothing and does not stop a claim. An expired lease does not stop one either. If this rule were wrong, the failure would be a machine that waits as standby behind a holder that is really up, which is the correct place to wait. Undoing the change is a plain code revert with no stored data to clean up.

## What this does not fix

We tested this in a simulation of the real machine code over two to three hours. Nothing here has run on real machines yet. The result depends on how long a restarting machine is fully gone before it starts asking again:

- Up to about 30 seconds: a single restart settles at once.
- From about 35 to 60 seconds: the holder's lease can run out first, because it has only 30 to 60 seconds left when the other machine stops. This can take a few extra restarts, then settles.
- Past the 60-second lease, on every restart: the swaps carry on. One long outage followed by short restarts settles.

Echo's one measured restart took 14 seconds. Luna's three, all auto-update restarts, took about 61 seconds, which is in the last band, and we do not know why. We have not measured whether a role restart takes as long. Luna's current log on this machine shows one role restart and no loop. We have no number for the two test servers yet.

Other limits:

- A machine that comes back with an expired lease at a higher number than a live holder still claims. That costs one extra restart and then stops.
- A peer that stalls past the 10-second ask can cause one more tie, and the next restart asks again.
- Pools of three or more machines can still lose sight of a live holder, because a machine remembers only one lease from its peers. That was already so, and it is tracked separately.
