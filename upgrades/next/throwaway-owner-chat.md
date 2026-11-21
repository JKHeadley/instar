# A stand-in owner chat for throwaway test agents

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

A throwaway test agent can now use a stand-in for the owner's private Telegram chat, so the phone approval screens can be driven live without a real owner. With `liveTest.throwawayOwnerChat.enabled` set, the stand-in is on only when the agent's folder really is in a temporary folder with an unexpired throwaway record, there is no messaging adapter, owner id, operator, introducer, earlier owner key, earlier device or other machine, and no other agent home shares its machine identity. It keeps the owner-chat messages in `.instar/state/throwaway-owner-chat.jsonl`, and a test on the same computer holding the agent token reads them and presses their buttons through `/throwaway/owner-chat/messages`, `/throwaway/owner-chat/tap` and `/throwaway/owner-chat/command`, which go through the same approval handlers a Telegram tap uses. If a condition stops holding it shuts off for good and declines what it carried; a home that used it is never paired with another machine. The Approve and Decline words are now shared between Telegram and the stand-in (unchanged). On every other agent nothing changes.

## Evidence

- `tests/e2e/throwaway-owner-chat-alive.test.ts`: on the production server boot, a temp-folder throwaway pairs a phone through the stand-in's Approve tap (the phone reads `active`, `approvedVia: 'telegram-dm'`) and declines a second; with Telegram configured the stand-in is refused and its routes answer 404.
- `tests/integration/throwaway-owner-chat.test.ts`: adding a messaging entry mid-run shuts it off, ends the pairing it carried, and its routes answer 410.
- `tests/unit/throwawayOwnerChat.test.ts`, `tests/unit/throwawayOwnerChat-pairing.test.ts`: every refusal, the route gate, bounds, the sweep and the pairing refusal.
