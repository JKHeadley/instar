# Only the owner's own words teach the agent the owner's preferences

## What Changed

The agent learns the owner's preferences from corrections in conversation. A message from a team member (through their phone or the app) was meant to be excluded from that learning, but the mark that says "a team member wrote this" was dropped before the learning step read it. The mark is now kept, and one shared rule (`src/core/ownerWords.ts`) decides what counts as the owner's own words for every learning path. It is an allowlist on the owner: a Telegram message whose verified sender is the owner (any verified sender when no owner is configured), or an app message from the owner's paired phone, and never forwarded text. Team members, another person's paired phone, other people in a shared topic and senders that could not be verified never count. Their turns still enter the conversation window the learning step reads, marked as not the owner's, so nothing is learned from them as the owner's preference.

## What to Tell Your User

Nothing changes in how you talk to your agent. Messages from your team members no longer shape the preferences your agent learns from you.

## Summary of New Capabilities

None. Security hardening of preference learning.

## Evidence

Reproduced in unit tests: before this change a team member's message was logged without its team mark and was sent for correction classification; now it is logged with the mark and is never classified, and forwarded text, other people in a shared topic and unverified senders are excluded too. The owner's own messages are classified exactly as before.
