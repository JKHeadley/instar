# The outbound check knows what the agent can already reach

## What this change is

Before an agent's message goes out, an outbound check reads it. One of its rules (B17, "false blocker") stops messages that hand the operator work the agent could do itself. The check only ever saw the message text. So when an agent wrote "only a browser you've set up can see that list, so I need your eye on it", the rule read that as a real access limit the operator had to solve. In fact the agent's own key read that list. Half an hour later the same agent said "someone has to message me in Slack", while its browser was signed in to the operator's Google and Slack. The operator caught both by hand (topic 134088, 2026-11-09).

This change gives the rule the missing facts.

## What already exists

- The outbound check and its self-stop rules B15 to B19. B17 already blocks "a human has to do this" when the agent has the means.
- A registry of browser profiles on each machine, listing which accounts are signed in to each and whether each is the agent's or the operator's.
- A short list of those profiles at session start.

## What is new

1. **A small phrase detector** flags messages that ask the operator to look at, check, open or send something ("can you check", "I need your eye on it", "message me in Slack"). It only raises a flag and never blocks anything by itself.
2. **A reach list.** When the flag is up, the check also gets the accounts signed in to this machine's browser profiles, plus what the agent's own key reads (everything the dashboard and app show).
3. **A reach rule inside B17.** If that reach plainly covers the errand, the message is a false blocker and the agent is told to do the errand itself. The rule text is added only when the flag is up, so every other message is checked exactly as before.
4. **A longer session-start list.** The browser-profile list was capped at 800 bytes, so this machine showed 3 of its 12 profiles and hid the operator's Google and Slack accounts. The cap is now 2400 bytes. The list also gains one line: do it yourself if an account or your key reaches it, and mark anything you send as the operator.

## The safeguards

- Taste and judgment questions still pass ("does this feel right to you?"). So do passwords, 2FA codes and CAPTCHAs, accounts the list doesn't show, and anything the operator asked to do themselves.
- Using the operator's account counts as reach only for looking, checking, or sending a clearly marked test or on-behalf message. It never covers a purchase, a setting change, or a real message to someone else in the operator's name.
- When the check is unsure, it lets the message through.
- The list carries no passwords, vault names or folder paths, only service, account name, owner and profile name, cleaned and length-limited.
- Any error leaves the check running exactly as it did before.

## What the reader needs to decide

Nothing. It ships on by default. To undo it, revert the change. It leaves no stored state behind.
