# Bind approval to the exact history preview

## What Changed

The internal consent adapter checks the same disclosure when issuing a Face ID challenge and when verifying the signed response. It checks current source ownership both times.

## What to Tell Your User

The preview and Face ID approval are being prepared together. Importing real conversation history remains paused.

## Evidence

Synthetic tests exercise a signed encrypted preview followed by a real presence signature, a changed disclosure, a different apply request, unavailable ownership and a replayed confirmation.
