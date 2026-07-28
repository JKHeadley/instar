# The standby now takes over as soon as the safety window opens

In a two-machine setup, the standby already knew how to prove that the serving
machine had stopped renewing its signed lease. The proof window is deliberately
conservative: with the standard settings, the same signed lease must remain
unchanged for about two minutes before a takeover is allowed.

There was still a timing gap. The standby checked that proof while pulling the
serving machine every few seconds, but only attempted the actual takeover on a
separate two-minute timer. If the proof became sufficient just after that slow
timer fired, the standby could wait almost another two minutes. This is why the
2026-07-23 Codey laptop-offline test left the mesh naming the dark laptop while
reporting no awake machine.

The peer-pull loop now wakes the existing fenced lease actor as soon as the
existing safety rules say takeover is eligible. It does not introduce a second
way to claim serving: the same signed evidence, monotonic non-renewal window,
preferred-machine rules, observe-only mode, and compare-and-swap fence all still
apply. It only removes the unrelated timer-phase delay.

The preferred Mini also remembers that the fenced authority granted this exact
takeover epoch. That lets it keep the same epoch alive while the laptop remains
offline, instead of dropping serving after one lease lifetime while waiting for
the much slower registry-death threshold. This memory is process-local and
epoch-bound: a restart forgets it, and any higher epoch immediately wins.

A regression test recreates the offline-test shape: the laptop's lease remains
valid by wall clock but its signed nonce stops advancing. After the two-minute
evidence window, the next pull makes the Mini claim the next epoch, become awake,
and restore writable serving without waiting for the slow heartbeat timer. A
second ratchet proves that the preferred Mini keeps that exact takeover epoch
alive when the laptop cannot confirm renewals.
