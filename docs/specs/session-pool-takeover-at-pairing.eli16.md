# A new agent's spare machine can take over

When a new agent pairs its second machine, sharing turns on, but the spare machine still could not take charge if the first one died. It had nothing to confirm its claim with, so it kept giving up.

We tested the fix on two servers. When we killed the machine in charge, the spare took over in about a minute and answered the next message exactly once. When we cut the link between them for 6 minutes, each test message got one answer, and they settled on one machine in charge afterward.

Then we paired two brand-new servers the way a new agent would, and found a trap. Pairing restarts the first machine, which changes its temporary web address, and neither machine had any other way to reach the other. With takeover on, both would stay in charge forever.

So pairing now swaps addresses that last, such as a home network or Tailscale address, and the spare only acts alone once the other machine has signed an answer over one of those. Until then the first machine stays in charge and the spare waits. So that pair has no takeover, and conversations stay on the first machine. The pairing says how to fix it.

One limit remains. A laptop that leaves home can lose its partner completely if both tunnels restart while they are apart. Then both stay in charge until they meet again, and jobs run twice for that time.

This turns that setting on when a new agent first pairs. Agents already paired do not change. Moving conversations on request is a separate step, still being measured.
