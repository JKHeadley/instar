# Keeping your phone's authority safe: what's wrong today, what changes, and three decisions

Your phone can do a lot as you: type commands into the agent's sessions, open the console without the PIN, approve changes and chat with the agent as its owner. Three security reviews looked at how the agent knows a request from your phone is really you. This page puts them together.

## How the agent knows it's your phone

Every paired phone has a **device key**. It signs every request, so the agent knows which phone sent it, but it signs without asking you. On your iPhone it lives in the phone's hardware vault and can't be copied off the phone.

An owner's phone also has a **Face ID key**, which only signs after Face ID or your passcode. The agent already asks for it before the most sensitive things: opening the console without the PIN, revealing the PIN, approving changes, closing or moving sessions.

## What someone could do today

- **Type into your sessions without Face ID.** Typing into a session uses only the device key. Someone holding your unlocked phone, or harmful software on it, could type commands, and sessions can do anything on the computer.
- **Chat with the agent as you.** A message from your phone is trusted as yours on the device key alone. The agent still reads and judges it, but it follows its owner's instructions.
- **Register a fake Face ID key on a computer that copies keys easily.** The Linux desktop app keeps its key where any program running under that login can copy it, and the agent can't tell. With that copy, someone could register their own "Face ID" key and pass every Face ID check, including the one that hands out the agent's access token.

Your own setup is not exposed to the third one: your two owner devices are iPhones, and there are no Linux or Windows owner devices in your pool. The fix still matters for anyone else running the agent.

## What changes

- **Typing asks for Face ID now and then.** One Face ID covers a stretch of typing: it lasts until you've been idle for 5 minutes, and never more than 30 minutes, after which it asks again. While you're typing back and forth you'll see Face ID at most about twice an hour. If it asks while you're sending, your message goes through right after Face ID; if you cancel, your message stays in the box. You can change both times. Typing is allowed as today until your app is updated, and once a phone has used Face ID for typing it always needs it.
- **Your phone's Face ID key is set up when you pair it.** The app sends it inside the pairing request you already approve, so there's no gap afterwards for anything to slip in, and nothing extra to do.
- **Computers whose keys can be copied can't act as the owner.** They can still chat and read, but they can't open the console, approve, reveal the PIN or type with Face ID. Older computers the agent can't classify get the same lower authority until you tell it what they are. Your iPhones are unaffected.
- **Risky chat requests ask you first.** For chat, a design is coming next: when a message from your phone asks for something risky, like running commands, changing access or deleting things, and wasn't recently confirmed with Face ID, the agent asks you to confirm before acting. Ordinary conversation stays exactly as it is, and the decision about what counts as risky won't be made by the same agent that's reading the possibly hostile message.

## What stays unprotected

- **Someone who has your phone and knows its passcode.** iOS accepts the passcode in place of Face ID.
- **Someone who picks up your phone while Face ID is still fresh.** They can keep typing until the 30-minute limit, because their own typing keeps it alive.
- **Harmful code inside the genuine Instar app itself**, for example from a poisoned update. It can do everything the app can and can wait for your real Face ID. What defends against it is how the app is built and released, not anything the agent can check.

## Your decisions

1. **Accept the Face ID prompts for typing.** The cost is up to about two Face ID prompts an hour while typing into sessions from your phone, for a problem rated medium-high rather than critical. **I recommend yes:** there's no way for the agent to know it's you without some Face ID moment, and this is the least frequent one that works.
2. **Accept that copyable-key computers lose owner actions.** On upgrade, a Linux computer, and any older computer the agent can't classify, loses console sign-in, approvals, PIN reveal and Face ID typing until you mark it. The PIN and your direct chat still work. **I recommend yes:** a copyable key behind owner authority hands out the agent's access token to any program on that computer.
3. **How fast to roll out the typing protection.** Standard: it runs on Echo first, everyone else's agents keep today's behaviour until it has proved itself, and "always require Face ID for typing" is offered to you only when every phone is ready. **I recommend the standard pace.** The faster option would switch it on everywhere right after the Echo trial, before the evidence is in.

The underlying designs are on the branch for these changes, and the Chief of Staff has the check results.
