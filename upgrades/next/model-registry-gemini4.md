# Gemini 4 Carbon and Hydrogen are recognized

## What Changed

Instar's model registry now lists Google's Gemini 4 Carbon and Gemini 4 Hydrogen on the Gemini door, as recognized but not promoted, next to Gemini 4 Argon. Both were live-checked on 2026-11-15 through the Gemini API and answered. No default model, tier or pin changes. The daily frontier-model check found them.

## What to Tell Your User

Nothing changes for you. Instar now knows about two newer Gemini models; it keeps using the same defaults until a new model proves itself.

## Summary of New Capabilities

None.

## Evidence

The models endpoint lists both. A trivial generateContent call returned "OK" from each (2026-11-15, paid Gemini key). The registry lint passes.
