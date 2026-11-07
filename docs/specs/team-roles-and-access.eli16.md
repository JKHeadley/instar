# Team roles and access, in plain English

## What this is

Today an Instar agent mostly belongs to one person. A phone is either the owner's, which can do everything, or an MSP's. This design lets a whole team use one agent, or a set of agents, from the app, with each person seeing only what they should.

## What already exists

The agent already keeps a list of people, and that list already has roles, used by Slack. Each phone already has its own secure key and belongs to a named person. The owner already has two switches for an MSP. Memory privacy already keeps one person's private facts away from another, once the owner turns it on. The app already keeps signed copies of what a phone sent, and can check them on any of the agent's machines.

## What is new

There's one set of roles everywhere, built on the list the agent already has:

- **Owner:** everything.
- **Admin:** keeps the agent running, including machines, schedules and accounts. An admin sees conversations only if the owner opens them. An MSP is an admin with a label saying they are from outside the company.
- **Member:** only the conversations they've been given, plus their own.
- **Guest:** can read the conversations they've been given, and can't speak in them.

The server enforces this on every request. The app hides what you can't use only to stay tidy. It isn't the protection.

The app gets a People screen. It lists everyone who can reach the agent, how they reach it and what they can see. From there the owner adds a person, gives or takes away conversations, and sees a list of who changed what.

For several agents, each agent stays independent, with no central service. Your role is per agent, and the app simply shows you the agents you belong to. An MSP with ten clients sees ten agents, and nothing crosses between them.

## Safeguards

- **The agent can take access away but can never give it.** Every change is a request signed by a person's phone, and the signed request itself is kept in a log copied to all the agent's machines. A forged entry is ignored. So nobody can talk the agent into giving them more. If someone asks the agent for access, the owner gets an Approve button instead.
- **Only the owner's phone can make someone an admin,** and that also needs Face ID. Admins can add members, but only to conversations they can read themselves.
- **Everyone on the team needs memory privacy on.** Their chats run in a locked-down session. Without that, one person could ask the agent to read files they shouldn't see, and the roles would mean nothing. If privacy goes off, those phones stop working until it's back.
- **A shared conversation stops using the owner's private memory.** Once someone else can read a conversation, the agent treats it as a shared place, and that person can read it only after this has taken effect. The owner is told before sharing.
- **Admins maintain, and don't get the keys.** They can fix health problems, pause jobs, close sessions and update the agent. They can't create jobs, type into a session, use Remote Desktop, or see passwords, because each of those reaches everything.
- **Telegram and Slack keep their own rules.** Anyone in the Telegram group can read every topic there, and Instar can't change that. So the app warns about it, and restricted people use the app instead of joining the group.
- **Everything is logged:** who changed what, and who was refused.

## What doesn't change

Existing agents work exactly as they do now. An update neither restricts anyone nor gives anyone more. An existing MSP phone stays as it is until the owner chooses to convert it to an admin. Restrictions begin only when an owner invites someone, and the invite says what changes. One example: once a team member exists, an MSP can read but not send in the owner's private conversations.

## What it costs

- A conversation shared with someone else loses the owner's private memory while it's shared.
- A person given a conversation can see its past, not just what comes next.
- The owner can read everything, including members' chats. Members are told this when they join.
- Scheduled jobs run for the owner and can read messages in the logs. That's within the owner's access, but the only thing keeping a member's words from steering a job is how the model behaves. Members are told, and it has its own fix on the list.
- The dashboard stays the owner's. The app is everyone else's way in.
- A conversation that has ever been shared, or that a member started, stays locked down for good, even after everyone else is removed.
- An agent that has had team members can't add a second machine until multi-machine support lands.
- A phone reaches one of the agent's machines, and can send only while that machine is the one serving the agent. Every phone already works this way.
- An agent that runs only on Codex can't have team members yet, because memory privacy only works with Claude Code.

## What comes first

The first piece restricts nobody. It lets an owner see who can reach their agent and what they can see, and it warns the owner when a second person can reach an agent with memory privacy off. That warning had no owner in the Thursday B2Lead report. After that come member phones on agents that run on one machine, with their People screens in the app. Agents on several machines come straight after that, because most of ours run that way. The multi-machine parts proved hardest, so they get their own review rounds. Then admin maintenance, adding people across several agents, and Slack conversations for members.

## What you need to decide

Nothing. No constitution change is needed.
