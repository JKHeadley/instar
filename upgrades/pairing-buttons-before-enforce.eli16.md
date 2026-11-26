# ELI16: pairing buttons on a brand-new agent

> The one-line version: a new agent now shows its pairing buttons in Telegram instead of sending you to the dashboard, and taps are checked exactly as strictly as before.

## The problem in one breath

On 2026-10-21 Justin paired PP with Echo. Echo showed buttons. PP, a normal new agent, sent him a message saying "open the Threadline tab on the dashboard" instead of a Finish button. Echo is a developer agent, so its safety check for Telegram taps is strict from day one. A normal new agent runs that check in a trial mode for its first day or more, and pairing switched its buttons off for the whole trial. That's when people pair a new agent, so everyone hit it.

## What changes

The buttons now show as soon as the agent's Telegram listener has proven it holds its secret. During the trial, once that proof has happened, the agent already rejects any tap that doesn't carry the secret. So letting pairing use the buttons in that state doesn't make anything easier to fake. A tap still has to come from the owner's Telegram account, in the right chat, with a one-time code.

## What stays the same

If the listener has never proven itself, the protection has been switched off on purpose, or the trial mode was pinned by the owner in the config, the agent still falls back to the dashboard. Only a verified tap can't be had in those cases.
