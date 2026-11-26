# Peer homebase topic: the "🤝 <peer>" name and the catch-up pass — explained simply

When Instar pairs with another agent, it can give that agent its own Telegram topic, so anything
that agent asks for lands in one place you can find. The first version named that topic
something like "pp · Threadline · abc123". That is not what the operator agreed to. He agreed to
"🤝 PP" — a handshake and the agent's name, nothing else.

This change does three things.

**1. The new name.** New topics are called "🤝 <name>", using the other agent's name exactly as
it calls itself. If two different agents happen to use the same name, the second one gets a short
piece of its ID added ("🤝 Echo · abc123") so they don't end up sharing one topic.

**2. Old topics are renamed, not duplicated.** A topic that already exists under the old name is
renamed to the new one. If the code is about to make a topic and finds one with the old name, it
reuses that one instead of making a second.

**3. Agents paired earlier finally get a topic.** Before, a topic was only made at the moment a
pairing was confirmed, so agents paired before the feature existed never got one. Now, shortly
after the server starts, the machine that is in charge checks every confirmed pairing and makes
the missing topics — at most ten per start, and a failure is just logged.

Nothing here changes who a message is from or what it is allowed to do. It only changes what the
topic is called and makes sure it exists. The whole feature stays behind the same on/off switch
(`threadline.peerHomebase.enabled`).
