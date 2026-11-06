## What Changed

When a new agent pairs its second machine, takeover is now turned on for that pair. If the machine in charge goes down, the other one takes over. Pairing writes `multiMachine.leaseSelfHeal.soloCaptainHold.enabled` and `requireLastingLink` on both machines, plus each machine's role.

Safeguards:
- Pairing now swaps lasting addresses (LAN, Tailscale or a named tunnel, never a quick tunnel).
- The joining machine takes over only after it has a signed answer from its partner over one of those addresses, recorded in `state/lasting-link.json`. Until then the first machine serves alone, so two machines that cannot reach each other never both answer.
- LAN detection now recognises Linux interface names such as `enp7s0`, and cloud `/32` interfaces pass the LAN check.

Agents already paired are unchanged. To turn takeover off on a pair, set `soloCaptainHold.enabled:false` on both machines and restart each. Reverting the release alone is not enough.

## What to Tell Your User

If you set me up on a second machine, the two now cover for each other. If the one in charge goes down, the other picks up your messages within a couple of minutes. That needs the two machines to be able to reach each other directly, on the same network or over Tailscale. If they can't, I'll tell you when you pair them, and the first machine keeps working on its own.

## Summary of New Capabilities

- Takeover at first pairing.
- Lasting-address exchange at pairing.
- Signed link proof (`state/lasting-link.json`).
- A new reason and fix in `GET /session-pool/readiness` for a pair with no lasting connection.

## Evidence

Fresh two-server drill (topic 137054, run 9, 2026-11-06), on a private network: 12 of 12 messages got exactly one reply, through a 30-minute power-off of the machine in charge, its return, a 6-minute cut of every link, and the heal. Without a shared network, one machine stayed in charge and the spare stayed quiet through restarts of both.
