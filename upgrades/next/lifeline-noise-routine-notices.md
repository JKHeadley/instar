# Lifeline Noise: Routine Notices Stay in the Logs

<!-- bump: patch -->

## What Changed

Two notices posted to the Lifeline on normal events. A background job with no
conversation that finished its work (not mid-work, no restart queued) now stays
in the reap-log; every other reap still notifies as before. The stop checker's
"not sure" answer (`escalate`) is now log-only. When the checker is sure an
unattended run stopped with work left, the notice now names the run by its goal,
quotes its last message, and goes to the run's own topic, where a reply reaches
it; with no named live run it is log-only. Both specs (notify-on-stop Layer B,
reap-notify R1.1) are amended, and the CLAUDE.md reap-notice sentence is updated
for new and existing agents.

## What to Tell Your User

Your Lifeline will be much quieter. Background jobs that finish normally no longer
post there, and neither do vague "a run stopped, want me to pick it up?" messages.
If an unattended run really does stall, you'll hear about it in that run's own
chat, with its name and the last thing it said, and you can reply right there.

## Summary of New Capabilities

- Stall notices for unattended runs arrive in the run's own topic, naming the run
  and quoting its last message.

## Evidence

Studio, 2026-11-01: 71 normal job finishes in about three hours were posted to the
Lifeline (all `sentinel-complete`, not mid-work), and the stop checker answered "not
sure" on 52 of about 450 stops in a day. Unit tests cover both sides of each
boundary; an integration test drives the real stop-gate route; the existing
reap-notify integration and e2e lifecycle tests pass unchanged.
