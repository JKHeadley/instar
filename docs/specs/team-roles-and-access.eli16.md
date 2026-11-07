# Team roles and access, in plain English

## What this is

Today an Instar agent mostly belongs to one person. A phone is either the owner's, which can do everything, or an MSP's. This design lets a whole team use one agent, or a set of agents, from the app, with each person seeing only what they should.

## What already exists

The agent already keeps a list of people, and that list already has roles, used by Slack. Each phone already has its own secure key and belongs to a named person. The owner already has two switches for an MSP. Memory privacy already keeps one person's private facts away from another, once the owner turns it on.

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

- **The agent can take access away but can never give it.** Only the owner's phone can raise someone, and making someone an admin also needs Face ID. So nobody can talk the agent into giving them more. Admins can add members, but only to conversations they can use themselves.
- **Inviting a member needs memory privacy on.** If privacy goes off later, members are locked out until it's back. Without this, "members can't see each other's private facts" wouldn't be true.
- **A shared conversation stops using the owner's private memory.** Once someone else can read a conversation, the agent treats it as a shared place. The owner is told this before sharing.
- **Telegram and Slack keep their own rules.** Anyone in the Telegram group can read every topic there, and Instar can't change that. So the app warns about it, and restricted people use the app instead of joining the group.
- **Everything is logged:** who changed what, and who was refused.

## What doesn't change

Existing agents work exactly as they do now, and nothing is restricted by an update. Restrictions only appear when an owner invites someone. An existing MSP keeps what they can see, and also gains the maintenance screens. The owner is told once, with a button to close their access.

## What it costs

- A conversation shared with someone else loses the owner's private memory while it's shared.
- A person given a conversation can see its past, not just what comes next.
- The owner can read everything, including members' chats. Members are told this when they join.
- The dashboard stays the owner's. The app is everyone else's way in.

## What comes first

The first piece restricts nobody. It lets an owner see who can reach their agent and what they can see, and it warns the owner when a second person can reach an agent with memory privacy off. That warning had no owner in the Thursday B2Lead report. After that come member phones, the People screens in the app, admin maintenance, admins adding members, adding people across several agents, and Slack conversations for members.

## What you need to decide

Nothing. No constitution change is needed.
