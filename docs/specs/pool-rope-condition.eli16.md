# ELI16 — Pool rows carry live rope-health reachability

Your agent can run on several machines that watch each other over multiple
network "ropes" (Tailscale, LAN, tunnel). One system — rope health — notices
a machine going dark within about a minute. A different system — the pool
registry — decides where new work gets placed, and it deliberately waits much
longer (~15 minutes) before declaring a machine offline, because you don't
want work reshuffled over a 5-second Wi-Fi blip.

The bug: the Machines display only used the slow signal. During a real test,
a laptop that was provably unplugged from the network still showed "online"
for 15 minutes.

The fix: the display data now carries the fast signal too, side by side. The
slow signal still runs placement, exactly as before; the fast one makes what
you SEE honest. On normal installs where the fast monitor isn't enabled,
nothing changes at all.
