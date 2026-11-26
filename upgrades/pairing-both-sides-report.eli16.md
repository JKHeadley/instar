# ELI16: pairing now tells both people how it went

> The one-line version: when two agents pair, both people now get a message at every step, the agents test that they can really talk before saying "Connected ✓", and if anything fails or stalls, both people are told in one plain sentence.

## The problem in one breath

On 2026-10-20 Justin paired two of his agents, PP and Echo. He tapped Approve on Echo, Echo said "waiting for the other side", and then nothing happened, on either side, ever. Nobody said it worked, nobody said it failed. Looking into it found several spots where a problem was only written to a log: the approval was sent once and never checked, a refusal from the other agent went nowhere, PP's "please finish" question went to a separate system topic (or nowhere), and only one side ever said "Paired".

## What already exists

- **Invite pairing:** one person's agent makes an invite, the other person forwards it to their own agent and taps Approve, and the first person taps Finish. The security of that (one-time secret, signatures, checking keys) does not change.
- **Telegram buttons and the dashboard** for Approve, Finish and Not them.

## What this adds

- **An instant answer to every tap.** Tap Approve and the agent replies straight away: "Approved — finishing the connection with PP and checking we can talk…".
- **The approval is resent until the other agent answers.** A few times over about five minutes. The other agent now always answers: "got it" (and whether its person still needs to tap Finish), or a signed "no, because…".
- **A real test before "Connected".** After pairing, each agent sends the other a short scrambled hello. Each one says "Connected ✓" only after it has the other's hello. If the hello never comes, the person is told the pairing is recorded but not yet confirmed.
- **Both people hear failures and stalls.** A refusal (the invite expired, was cancelled, was for someone else, or the other person tapped Not them) is told to both people. Five minutes with no answer, an invite nobody finished, an invite that expired unused: each gets one plain sentence.
- **Messages go where the conversation is:** the topic where the invite was posted or forwarded, not the system topic. If a message can't be delivered at all, it is reported as a problem instead of vanishing.
- **When both agents are yours,** your agent shows a button next to the invite: "It's one of my agents". Tap it, and you won't need to come back and tap Finish: your agent finishes by itself when your other agent accepts. No agent can know for sure that the person tapping Approve on the other agent is you, so this is a choice you make, and the risk is said plainly: if that invite leaked and a stranger used it first, there would be no "Not them" moment, though you would see the stranger's name and could unpair it.

## Safeguards

- The new messages are signed with the agents' keys and checked against the keys saved when pairing, so the relay in the middle cannot fake or change them.
- They are only sent to agents that say they understand them, so older agents pair exactly as before.
- Nothing about who may approve changes: the agent cannot tap any of these buttons for you.

## What is still open

This implements a proposed spec change that Echo has not reviewed and Justin has not approved yet. The questions for them: whether the "It's one of my agents" button is good enough until a true one-tap link can be built safely, whether passwords should wait for the hello test, and whether five minutes is the right wait.
