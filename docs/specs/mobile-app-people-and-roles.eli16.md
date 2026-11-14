# Phones belong to people: owner and MSP

## What this is

The Instar iPhone app lets a person talk to their agent from their phone. Today the agent assumes every paired phone belongs to its owner. If two people pair phones with the same agent, the agent still thinks the owner said everything either phone sent. That matters now: the operator is about to run an agent for a client as their MSP (the company that manages the client's IT). The client owns the agent, and both the client and the MSP need the app.

## What already exists

The agent already keeps a list of the people it knows (the user registry). Each entry has a name and the accounts the person uses, such as their Telegram or Slack id. Slack already uses that list to give people roles. Each paired phone already has its own secret key, kept in the phone's secure chip, so the agent can tell which phone sent each request.

## What changes

- Each phone now belongs to one person from that list, and has a role: owner or MSP.
- Every phone paired before this change counts as the owner's phone. Nothing changes for anyone already using the app.
- To pair a phone for the MSP, the agent makes the pairing link for that named person. The owner still gets the confirmation code, and the code message now says who the phone is for. The owner's approval is what lets anyone in.
- Messages from the MSP's phone carry the MSP's name. The agent never treats them as coming from the owner. In Telegram they show as "📱 MSP name (from the app)".
- The MSP can't post on Slack as the owner, and can't see the owner's private app chats. The MSP can still see the owner's Telegram topics, sessions and alerts, use their own app chats, and use emergency stop.
- If someone is removed from the people list, their phone stops working. It never turns into the owner's phone.

## Safeguards

Only the agent's API token can make pairing links or change which person a phone belongs to. A phone can't pick its own person or role. The owner's identity is never attached to someone else's message.

## The owner's switch

By default the MSP can't use the owner's private app chats or Slack. The operator decided the owner should be able to change that. The owner's phone has two switches per MSP: "can see my app chats" and "can use Slack". Both start off. Only the owner's own phone can flip them. Asking the agent to do it doesn't work, so an MSP can't talk the agent into giving themselves access. Even with Slack turned on, the MSP's Slack messages carry the MSP's name and the MSP's own permissions, never the owner's.

## What you need to decide

Nothing is open. The operator chose the default limits and the owner's switch on 2026-11-03.
