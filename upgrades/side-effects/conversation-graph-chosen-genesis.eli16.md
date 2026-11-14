# Choosing which machines a new conversation graph uses

Right now, when Conversations is first switched on, every machine paired to the agent becomes a full member. Every change then has to be saved on all of them before it counts. An agent with five machines, some of which sleep, would keep changes waiting most of the time, and there is no way to remove a machine from a group that large.

This adds an optional setting that says which machines to use when the graph is first created, such as two machines that are always on. The other machines stay paired and work normally for everything else. In Conversations they say they have not joined.

Nothing changes unless the setting is used. After creation the setting has no effect, because the signed list of members decides. Two machines with different settings cannot create two separate graphs when they can reach each other. They stop and wait until one is corrected. If the machine with a different setting is unreachable when the graph is created, it cannot be asked, so that case still needs the setting to be right on every machine.

The remaining weakness is that if the machine holding the agent's main lease is not one of the chosen machines, changes wait safely but do not finish until a chosen machine holds it again. The owner does not yet see why.
