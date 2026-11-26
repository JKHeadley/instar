# Pairing two agents by invite link, explained simply

Before two agents trust each other with secrets like passwords, each needs proof that it is talking to the real other agent, not an impostor in the middle. The relay that carries their messages could, in theory, swap one agent's key for its own. Pairing is how they rule that out.

The first version asked the person to read 12 words on one screen, compare them with 12 words on another, and then type all 12 in. Justin tried it and stopped: it is too much for anyone to do every time, and the screen kept wiping his progress. He was right, and this replaces it.

## What the person does now

1. On your agent's dashboard (or by asking your agent in Telegram), you make an invite. It is one short message with a code in it.
2. You send it privately to the other person, in whatever app you already use with them.
3. They forward it to their own agent's Telegram chat (or paste it into their dashboard). Their agent asks: "Pair with the agent that calls itself Scout, which says it belongs to Justin?" They tap Approve.
4. Your agent tells you who accepted, and you tap Finish.

Nobody reads, compares or types anything.

## Why it is safe

- The invite travels through your own chat app, not through our relay, so whoever runs the relay never sees it.
- The invite contains a one-time secret. The other agent proves it got the invite (with that secret) and proves it holds its own key (with a signature). An impostor would need both.
- Each agent also checks the key in the invite against the key the relay shows. If they differ, it refuses.
- An invite works once and expires after an hour by default, so keep it private until it is used.
- If someone else got hold of your invite and used it first, the real person's later attempt sets off an alarm on your side. The agent that got in first is paused straight away, even if you already tapped Finish, and it can't receive any secrets until you choose which one you meant. You get one alarm per invite, however many agents try it after that.
- If you're inviting an agent your agent already knows, choose it under "Who is it for?". The invite then works only for that agent, so a leaked copy is useless to anyone else.
- Your agent keeps a short log of what happened to each invite (when it arrived, and what you decided), without the invite's secret.
- Approving by Telegram only counts when the message really came through your agent's Telegram listener, protected by a secret only the listener holds, and from your own Telegram account. Otherwise you approve on the dashboard with your PIN.
- (Change r5, approved 2026-10-21 after Echo's review.) A brand-new agent runs its listener protection in a trial mode for its first day or more. The buttons used to be switched off for that whole time, so the first pairing on a new agent always said "go to the dashboard". That is what happened when Justin paired PP. Now the buttons show as soon as the listener has proven it holds its secret. Each tap still has to carry that secret, and the trial mode already rejects taps that don't, so the check is just as strict.
- (Change r6, approved 2026-10-21.) If an agent still can't show buttons, its message now says why, for example "its Telegram listener has not yet proven itself", and which Instar version it runs. When Justin tested PP again it still said "go to the dashboard", and nobody could tell why without getting onto PP's machine.
- (Change r7, proposed 2026-10-21.) Luna checked PP and found the real reason. PP has no separate Telegram listener: its own server reads Telegram directly. Pairing switched its buttons off for any agent set up that way. Now those agents take the invite and your taps straight from Telegram, with the same checks: it has to be you, in your chat, with that button's one-time code.

## What it can't do

It can't stop you from approving an agent you don't know. That's why the screen always says the names are "claimed", not checked.

## Change r4 (approved 2026-10-21): both people hear how it ended

Echo tested this change on the Studio and Justin chose the "It's one of my agents" button described below. It shipped in PR #2270.

On 2026-10-20 Justin paired two of his own agents. He tapped Approve on one, it said "waiting for the other side", and then nothing happened anywhere. Nobody was told whether it worked, failed or was still going. The agents had several places where a problem was written to a log file and nowhere else, and the approval was sent once with nobody checking it arrived.

What this change does:

- **Every tap gets an answer straight away.** Tap Approve and the agent replies at once: "Approved — finishing the connection with PP and checking we can talk…".
- **The approval is sent again until the other agent answers.** It is resent a few times over about five minutes. The other agent now answers every approval, either "got it" or a signed "no, because…", so a lost message no longer stalls everything.
- **The agents test the line before saying it worked.** After pairing, each agent sends the other a short scrambled "hello". Only when each has received the other's hello does it tell its person "Connected ✓". So "connected" means they really did talk, privately, both ways.
- **Both people hear about failure too, in one plain sentence.** If the other agent says no (the invite expired, was cancelled, was meant for someone else), both people are told why. If nothing comes back within five minutes, both are told that too, and told what to do. If the other agent answers later, they still get told.
- **Messages go where the conversation is.** The agent posts in the chat topic where the invite was made or forwarded, not in a separate system topic, and if it can't post at all, that shows up as a problem report instead of disappearing.
- **If the inviting agent restarts partway through.** A restart makes it forget whether the other agent understands the new "can we talk" check. So it waits up to a minute for the other agent's hello. If the hello comes, both agents tell their person "Connected ✓" as usual. If none comes, the other agent is an older version, and the inviting agent says the pairing is done but couldn't be checked, which is true.
- **Unused invites don't vanish silently.** When an invite expires unused, the person who made it is told.

**When both agents are yours.** There is no way today for one agent to check that the person who tapped Approve on the other agent is its own owner: each agent only knows its own owner, and anything one agent says about its owner is just a claim. So the agent never assumes it. Instead, when your agent shows you an invite, it also shows a button, "It's one of my agents". If you tap it, your agent finishes the pairing by itself when your other agent accepts, so you don't have to come back and tap Finish. The catch, said plainly: if that invite leaked and a stranger used it first, there would be no "Not them" moment. You would see the stranger's name in the "finishing by myself" message and could unpair it, and if your own agent then used the invite, the alarm would go off and the stranger would be paused. If you don't tap the button, nothing changes.

**What you'd be deciding.** Whether that button is a good enough answer to "no second tap" until a one-tap link straight to your other agent can be built safely, whether passwords should also wait for the "hello" test, and whether five minutes is the right time to wait before saying something went wrong.
