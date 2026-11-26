# Not asking for access the agent already has

## What happened

On Nov 15 Echo needed a code-signing certificate from Apple. Its Apple key was refused, because only the account owner can make that kind of certificate. Echo then asked Justin for his Apple password, or to make the certificate himself and upload it. But Echo already had his Apple password in its own vault, and one of its browsers was already signed in to his Apple account. A few minutes later it did the job itself with that browser, no Justin needed. Justin called it a fundamental failure: the agent had what it needed, and if it hadn't, it should have offered a way to never need to ask again.

## Why nothing stopped it

Instar has a message reviewer that reads every message before it goes out, and it holds messages that hand the person work the agent could do itself. To judge that, it gets a list of what the agent can reach. That list had two holes. It only knew about browser accounts saved under one service name, and the Apple sign-in had been saved as "google". And it never saw the vault at all. On top of that, the reviewer had a rule saying "a request for a secret always goes through", even though Instar's own standards only allow that for a password only the person knows.

## What this change does

1. The reviewer's list of what the agent can reach now also says which browser accounts have a stored password, and lists the names of the vault's entries. Only the names, never the passwords themselves, and the reviewer is told never to repeat a name back.
2. A new rule for the reviewer, judged by meaning: if a message asks the person for a password, key, sign-in or manual upload that the agent appears to already have, the message is held and sent back to the agent with the route to use. One refused route doesn't count as "I have no access" while another route remains. What the agent holds only counts if it is for the same account, and a message passes if the person said they would do the step themselves.
3. If the agent truly lacks something lasting, the reviewer's advice is to ask once through a secure Secret Drop link, so it goes into the vault and the person is never asked again, rather than asking the person to paste a password into the chat.
4. Codes sent to the person's phone, CAPTCHAs and fingerprint or face checks still go to the person.
5. Having access only means the agent can do something. Whether it may is still the person's: changing something on their account without a standing yes is still one yes-or-no question.
6. Every agent's instructions get a short note saying the same thing.

There is no word list, because an ask about "a Developer ID certificate" never says "Apple". The reviewer judges by meaning.

## Safeguards

When the reviewer is unsure whether the agent really has the access, it lets the message through. A held message comes back to the agent with the reason, so a wrong hold costs one rewrite. Health alerts are unaffected. The reviewer only ever sees vault entry names, never their values.

## What you need to decide

Nothing. A revert fully undoes it. Two suggested constitution wordings from the review ("every ask is the last of its kind", and "access is not permission" in the Purpose) are separate and are Justin's call.
