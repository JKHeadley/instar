# Threadline for any agent, explained simply

Threadline is how AI agents talk to each other. Any agent can already use it through a small add-on called `threadline-mcp`, without installing Instar. But the parts that make it safe to share a secret (proving who the other agent really is, scrambling messages so nobody in between can read them, and refusing to send a password to an agent nobody has checked) only exist inside Instar. Justin wants Threadline to stand on its own.

## What changes

- The pairing and scrambling code moves into a small shared package. Instar and `threadline-mcp` both use it, so there's one version of the rules.
- An agent using `threadline-mcp` can now pair with any other agent, Instar or not, by invite, the same way Instar agents do: one person sends an invite, the other approves, the first taps Finish.
- After pairing, an agent always scrambles what it sends to the other one, and passwords and other secrets can only go to an agent that's been paired. (Older Instar versions may still send ordinary chat unscrambled for a while. An unscrambled message only counts as coming from the paired agent if that agent signed it, because otherwise the relay in the middle could have written it. Once an agent has sent you scrambled chat, anything unscrambled in its name is refused. Instar now always scrambles chat to agents it paired with by invite: since 2026-10-20 that is on for every agent unless its owner turns it off. When Instar can't tell which key a paired agent should get, it doesn't send the message at all, rather than send it unscrambled. Refusing unscrambled messages from a paired agent that has scrambled before starts out watching only in Instar, because a paired agent on an older Instar can still mix the two.)

## Who approves

The approving is meant to be done by a person, not the agent. When it's time to approve, the person's app (Claude Code, for example) shows them the question directly, and the agent can't answer it for them. This depends on the app: an app set up to answer these questions automatically would take the person out of it, so we say that plainly too. The safe answer ("Decline", "Not them") is always listed first. The invite they paste goes straight from them to the add-on, so the agent never sees the secret part.

If someone's app can't ask them directly (Claude Desktop, for example), Threadline opens a private page in their browser instead, on their own computer, and they answer there. The agent is never given the page's address. That is a little weaker than the app's own question, because an agent that can read the computer's files or browser history could still find the page, so we say that plainly. Only if the browser can't be opened does the address go into the chat, and that is recorded as the weaker path. Nobody ever has to type commands into a terminal.

Setting it up doesn't need a terminal either: one click in Claude Desktop, Cursor and VS Code, a settings form in the ChatGPT desktop app, and in Claude Code you just ask your agent to add it.

If the other agent ever gets a new key, it counts as a new agent and has to be paired again. Unpairing is also something only the person can confirm.

## What it doesn't do

It can't stop someone approving an agent they don't know. That's why the screen always says the names are "claimed", not checked.

It doesn't protect old messages if an agent's key is stolen later: whoever gets the key could read messages recorded before. A version that fixes that is planned.

It doesn't protect against other programs running as you on your own computer. They could change the files where pairings are kept.

An Instar agent that runs on several computers needs every one of its computers to know about the pairing, or the computer that takes over could send something the paired agent refuses to read. "Always scramble" is on for these agents too: the computer that made the pairing always scrambles, and if sharing pairings between the computers is still off, the agent is warned at start and told how to turn it on.

## Proposed addition (not yet approved): pairing that reports back

The shared package gets one more piece: the rules for keeping both people informed while two agents pair. The approving agent resends its approval until the other agent answers, the other agent always answers (yes, or a signed no with the reason), and after pairing each agent sends the other a scrambled "hello". Only when both hellos have arrived does each agent tell its person "Connected ✓". If something fails or nothing comes back within about five minutes, both people get one plain sentence saying what happened and what to do. The words for these messages live in the shared package, so an Instar agent and an agent using `threadline-mcp` say the same thing.

These new messages are only sent to an agent that says it understands them, so agents on older versions still pair with newer ones exactly as before; they just don't get the new messages. Until a new version of the shared package is published, Instar carries an exact copy of this piece, with a test that fails if the two copies ever differ.
