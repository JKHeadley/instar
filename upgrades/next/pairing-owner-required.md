## What Changed

Threadline pairing invites now require owner info. An agent that does not know its owner's name cannot make or approve an invite, and an invite or accept that names no owner is refused before any prompt appears. The owner name now resolves from `threadline.ownerName`, then registered users, then the one verified Telegram operator.

## What to Tell Your User

Pairing invites now always say who the agent belongs to. An invite from an agent that doesn't say is refused, and that agent needs updating before it can pair with me.

## Summary of New Capabilities

Owner info is required for pairing. New optional setting: `threadline.ownerName`.

## Evidence

Justin saw "echo (unknown owner's agent)" on a live invite on 2026-10-30. Unit tests run the refusals against both handshake copies and the owner lookup against the real file layout; an end-to-end test refuses both cases through the production bootstrap.
