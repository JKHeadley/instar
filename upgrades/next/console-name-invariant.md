# Console display names use verified labels

## What Changed

The console, older dashboard views, and server notices now use verified names across people, machines, conversations, messages, subscriptions, and work pages. Routing IDs and fingerprint fragments no longer appear as substitute names; missing names are shown plainly, and ambiguous targets are omitted from action pickers. The shared topic-name rule also rejects “topic 123” and “Telegram topic 123” placeholders.

## What to Tell Your User

Names are shown wherever the connected service has verified them. A missing name is labeled as unavailable. An action menu or subscription approval with two indistinguishable targets will not guess which one you meant.

## Summary of New Capabilities

One shared name rule now covers the stable console, legacy dashboard, subscriptions, server notices, and server-side topic identity checks. Name-based actions require a unique verified label; pool diagnostic responses retain machine IDs separately for tracing.
