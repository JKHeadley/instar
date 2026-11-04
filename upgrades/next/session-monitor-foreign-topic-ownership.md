<!-- bump: patch -->

## What Changed

Fixed false “The session has stopped” notices from a machine that does not own the conversation. The session monitor now follows the topic ownership record, even when the owner is temporarily offline or a handoff is in progress, and checks ownership again after recovery or triage before sending a notice. Conversation replies remain available.

## What to Tell Your User

You should no longer get a stopped-session message from a different machine while your conversation is assigned elsewhere. A genuine stopped session on its owner machine can still be reported.

## Summary of New Capabilities

No new action is needed. Session status notices now come from the machine responsible for the conversation.

## Evidence

Bug topic 10000001574 reported three false notices in topic 135786. Telegram history confirms the three notices on November 3 Pacific, and the Mac Studio's ownership record assigned that topic to Mama PC before the first notice. Seven new regression checks failed before the fix; 53 targeted unit checks pass after it, and the TypeScript build check passes.
