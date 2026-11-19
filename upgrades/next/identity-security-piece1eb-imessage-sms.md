# iMessage: a text message can no longer pretend to be one of your contacts

<!-- bump: patch -->

## What Changed

Your agent can answer contacts through the Messages app on your Mac. A real iMessage is tied to the sender's Apple account. An ordinary text message (SMS) is not: anyone can send a text that shows one of your contacts' numbers. Until now the agent treated such a text as that contact.

Now only real iMessages count. A text message (SMS, RCS or similar) that claims to be from a contact is left alone:
- no session starts;
- nothing is answered;
- its words and pictures never reach the agent's conversations.

You still have it in your Messages app. Once a day the agent tells you how many it set aside, and which numbers they claimed.

## What to Tell Your User

- **Text messages**: "I only act on real iMessages now, because an ordinary text can show anyone's number. If you text me while iMessage isn't working, I'll let you know and you can resend it as an iMessage or reach me another way."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unproven texts are set aside | Automatic; one daily notice with the count |
| Which history rows can prove their sender | `GET /imessage/chats/:chatId/history` rows carry `senderProven` |

## Evidence

- Unit: `tests/unit/identity-piece1eb-imessage-sms.test.ts` (real Messages-schema database).
