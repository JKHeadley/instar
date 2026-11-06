<!-- bump: patch -->

## What Changed

The B23 send check now works beyond Telegram. Slack, app, WhatsApp and iMessage sends give it that conversation's recent turns, read from each channel's own log; the tone review sees them only under attribution `enforce`, and the background send record uses them whenever attribution is on. Spawned Slack sessions can now send the tone reaction, and nothing else, as `metadata`. Without those turns the crediting half of B23 could never fire off Telegram. `slack-reply.sh`, `app-reply.sh`, `whatsapp-reply.sh` and `imessage-reply.sh` now take `--tone-ack`, `--tone-reason`, `--tone-complied` and `--tone-decision-ref`, and print an advisory with how to answer it. Before, a Slack advisory could not be answered and `--tone-ack` was read as the channel id. `imessage-reply.sh` also stops using `head -n -1`, which fails on macOS and lost the reason for every refusal.

## What to Tell Your User

If I'm about to tell you on Slack, the app, WhatsApp or iMessage that someone said something I can't source, the check can now catch it there as it does on Telegram, once the attribution feature is set to refuse. Nothing changes for you until then. If one of my messages is held, I can now revise it or answer the check on any of these channels.

## Summary of New Capabilities

The tone-gate reaction flags work in every reply script, not only Telegram's.

## Evidence

Live test, 2026-11-06, instar 1.3.1686, real Slack test workspace: two false credits to a person were sent, not held, while the same text was held on real Telegram. The tone decision shows `pass: true`, and the code reads recent turns only for a Telegram topic id. `--tone-ack` failed with `channel_not_found`. The rerun on real Slack is recorded in `.instar/lanes/attribution-live-rung-1106/REPORT.md`.
