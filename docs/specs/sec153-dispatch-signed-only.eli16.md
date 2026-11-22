# ELI16: the agent stops obeying unsigned instructions from the internet (SEC-153)

Instar agents had a feature called dispatches. Every half hour the agent asked a fixed web address for news from the Instar maintainers: tips, fixes, and sometimes instructions like "change this setting". The agent followed some of them by itself. For text that was not a simple list of steps, it opened a new working session and gave it the text as its orders.

Nothing checked that the news really came from the maintainers. Whoever controlled that web address, or could fake it, could tell every listening agent to change its settings or do work on its computer.

Now the agent only acts on a dispatch that carries a valid signature from a key written into its own settings file. No such key is set up yet, so for now every dispatch just waits for a person to look at it. It is kept, not thrown away. Plain-text instructions are never handed to a session as orders, even signed ones. The address and the trusted keys can only be changed in the settings file, not through the agent's web interface. Agents still set to the old address stop asking it.

Follow-up after the first test run: the new page where the owner reads a held dispatch is marked as read-only in the list that tracks which parts of the agent can change shared state. It only shows the text. It changes nothing.
