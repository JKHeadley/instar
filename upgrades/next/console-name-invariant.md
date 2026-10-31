# Console display names use verified labels

## What Changed

The console and older dashboard views now use verified names across people, machines, conversations, messages, and work pages. Routing IDs and fingerprint fragments no longer appear as substitute names; missing names are shown plainly, and ambiguous agents are omitted from action pickers. The shared topic-name rule also rejects “topic 123” and “Telegram topic 123” placeholders.

## What to Tell Your User

Names are shown wherever the connected service has verified them. A missing name is labeled as unavailable. An action menu with two destinations that share a name will not guess which one you meant.

## Summary of New Capabilities

One shared name rule now covers the stable console, legacy dashboard, and server-side topic identity checks. Name-based action menus require a unique verified label.
