# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Bug fix: MessageSentinel LLM classifier no longer misclassifies conversational "hold on" as pause.**

- Fixed MessageSentinel LLM classifier prompt: moved "hold on let me think" from the pause examples to the normal (conversational) examples. Messages like "hold on let me think" (5+ words that bypass the fast-path word gate) were being sent to the LLM which classified them as `pause` because the prompt listed this exact phrase as a pause example. The fix adds a KEY DISTINCTION instruction and clearer directive-only pause examples.
- Fixed the fresh-install integration test to expect 21 default jobs (was 20) after the identity-review job was added to the default job set in the previous release. No runtime behavior changed — the test expectation was simply out of date.
- Updated blog page with images, corrected publish date, synced with latest draft, and added canonical URL metadata.

## What to Tell Your User

- **Reliability**: "Fixed a false positive where saying 'hold on let me think' (or similar conversational phrases) could accidentally pause your agent session. The MessageSentinel now correctly distinguishes between user thought-narration and actual pause directives."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| No behavior changes | This is a bug fix release |
