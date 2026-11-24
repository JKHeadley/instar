# Check for existing work before starting something new

A1 gives Instar a way to find earlier conversations, decisions, and code. A2 puts that evidence into the places where the agent decides what to say or whether to start something. An agent can continue existing work, explain why a related idea is distinct, or say which evidence it could not check. Looking up work never grants access to private material or permission to act.

When the same request reaches Instar twice, such as after a restart or through two related conversations, the service responsible for it keeps one record of what it accepted. Similar requests can still become separate projects. The lookup only gives the agent evidence to weigh. Private work that the current person cannot see cannot affect what their search shows or reveal itself because an unrelated request is delayed or rejected.

Some outside services cannot tell Instar whether an action went through after a connection breaks. For those actions, Instar records who started the attempt before making the call. A replacement worker checks what happened before trying anything again. If it cannot establish that the earlier worker could never send the action and the effect did not happen, it keeps the result as uncertain and routes it to the authorized owner. A timeout alone cannot cause a second send.

We will test the original permanent-links question, related work that really is distinct, private work alongside shared work, and a paused worker that wakes up after another machine takes over.

The first implementation observes successful direct owner text in the Chief of Staff Telegram topic after it reaches the existing session. The observation uses the public pull-request inventory and records only a coarse outcome. It leaves the message and any decision about what to do with the agent.

The first rollout entry covers observation after a verified owner message. It asks for evidence that the lookup finds useful earlier work, stays within the normal response budget, and protects private results. It gives the observer no permission to start work or send anything.
