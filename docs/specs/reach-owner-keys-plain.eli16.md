# "Who can reach me": the owner's own identities read plainly

## What this is

The dashboard page "Who can reach me" lists everyone who can talk to the agent. For the owner, when more than one identity counts as "you", the row adds a note: "Treated as you: …", followed by those identities. On 20 November the live check of the dashboard (part of the "finish the dashboard makeover" project, whose goals include names everywhere an ID used to show) found that this note printed one of them as "Profile telegram-7812716706". That is an internal profile key, not something the owner would recognise.

## What changes

An Instar profile key now reads as "your Instar profile". Telegram, iMessage, Slack and WhatsApp identities read as before ("iMessage +1…", "Telegram …"), because a phone number or account is how the owner knows which of their accounts is meant. Only the owner sees this note.

## What is not affected

Who counts as the owner, who can reach the agent and what anyone can see are all unchanged. This only changes the words of one note.

## What you need to decide

Nothing. It is a small wording fix that a revert fully undoes.
