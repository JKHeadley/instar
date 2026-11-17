# Organizations and invitations, in plain words

## What this is

Justin approved "easy setup for new people" on 16 November 2026. Part of it is for organizations, such as the Monroe Institute, that have an AI policy. Every colleague's agent should follow that policy from its first minute. This part lets the person in charge publish the policy from their own agent and send colleagues an invitation link. The colleague opens it, sees one screen about what joining means, and their agent follows the policy from then on.

## What already exists

- Each agent can keep organization rules in one file and reads them at the start of every conversation.
- An agent can be asked whether a given action would be allowed by those rules.
- Someone has to type the rules into that file by hand, on each agent. Nothing says which version an agent has or who wrote it.
- Nothing stops an agent's independence being turned up past what the organization wants.

## What is new

- **A policy pack.** The organization's policy, kept as a readable document, plus a small record of the version, who published it and when, and the most independence it allows. The organization gets its own signing key the first time it publishes. The key stays on that computer, and new versions are published from there. It signs every version, so a joined agent can tell a real update from a fake one. Both the person in charge and the join screen show a short code for that key, so colleagues can check they're joining the right organization.
- **Set up by talking.** The person in charge says "set up our organization" and pastes their policy, or Instar's starter policy. The agent reads it back, asks about anything it couldn't place, and tries twenty everyday requests to show how strict it is. It publishes only on an explicit yes.
- **An invitation link.** The whole policy travels inside the link, in the part a web server never sees. The colleague opens it on instar.sh or in the Instar app, reads one screen, and presses Join. Their agent checks the signature and the fingerprint, writes the rules, and caps its own independence.
- **Updates.** When the person in charge publishes a new version, joined agents that can reach their agent check for it once a day. Any change to the wording waits for the colleague's yes, because any line, even a "never" line, can carry an instruction. Only a lower independence limit is applied without asking, with a one-line note.
- **Joining before signing in to an AI account.** The installer can take an invitation, so the app can show the join screen before the AI sign-in.

## Safeguards

- Publishing, joining, leaving and accepting an update all need the person to tap in the Instar app, on a screen showing the whole policy. The agent can't do any of them alone, so a link arriving in an email can't make an agent join. That means this version needs the app; an agent with no app paired can't join yet.
- The first join remembers the organization's key. A later version signed by anyone else is refused and shown to the owner, and so is an older version.
- The independence limit covers the settings that actually take effect, not just the setting's name. A policy can never raise independence, read conversations or add a person.
- Joining doesn't let the organization see anything. In this version it sees nothing at all after sending the invitation.
- The join screen shows every line that will reach the agent. It also says exactly what is checked today. Outgoing messages are checked against the "never" list only on agents with that check turned on, which is off by default. Other actions aren't checked yet.
- "Ask first" items are things the agent asks about. They are never turned into blocks on its messages.
- Policies have a size limit, because the whole policy is read at the start of every conversation.
- A rules file someone edited by hand is never silently replaced. The agent asks first.

## What it can't do yet

- Strict blocking of "never" rules is the next part, and it needs Justin's yes.
- Check-ins, a list of the organization's agents, a second policy keeper and leaving tools come after that.
- The iPhone app's join screen follows the Mac app's, using the same link format.

## What needs deciding

Nothing from Justin for this part. Turning on strict blocking for joined agents, and whether work agents are separate from personal ones, are separate yes/no questions for later.
