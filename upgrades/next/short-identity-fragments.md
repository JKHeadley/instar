# Short fingerprint fragments no longer appear as agent names

<!-- bump: patch -->

## What Changed

The verified-name rule now rejects eight-character fingerprint fragments, longer hexadecimal identifiers, and UUIDs presented as agent names. Saved delivery records are filtered when read as well as when new names are recorded.

## What to Tell Your User

Agent rows use a real name when one is known. If only an identifier is available, they say the agent's name is unavailable rather than showing a code.

## Summary of New Capabilities

The shared name validator applies the shortened-hash rule already stated in the UX standard to agent health and delivery data.

## Evidence

The console preview reproduced the live eight-character labels before the change and displayed “Unnamed agent” afterward. Focused validator, delivery tracker, and console model tests pass. Full suite and Mac verification remain release gates.
