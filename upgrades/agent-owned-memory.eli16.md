# An agent's memory belongs to the agent, not to a login (plain-English version)

Instar runs its agents on several paid Claude accounts, which we call logins, so work can keep going when one account runs out of quota. Each login keeps its settings in its own folder on the computer.

Claude Code, the program the agent runs in, also keeps the agent's "auto-memory" there: the notes it writes itself about rules, lessons and preferences. Because every login has its own folder, every login ended up with its own separate piece of the agent's memory. When the agent moved to a different account, it forgot what it had learned on the others. On one machine, the echo agent's memory was split nine ways. The operator's rule is plain: accounts are for tokens and quota only, never for storing the agent's data.

This change gives each agent one memory folder of its own, inside the agent's own directory. In every login's folder, the spot where Claude Code looks for memory becomes a pointer (a symbolic link) to that single folder. Whichever account a session uses, it reads and writes the same memory.

Memory that already sits in a login's folder is not thrown away. It is merged into the agent's folder first. When two copies of the same note differ, the newer one is kept as the main copy and the older one is saved in a `_superseded` folder. The two memory indexes are combined. The old folder is renamed `memory.pre-shared` and left in place. Running this again changes nothing.

This happens automatically before every Claude session starts, when a new account is signed in, and once for every existing agent when it updates. It only acts for a real agent. It never creates an account folder that doesn't exist, and a throwaway test agent never touches real accounts.

Conversation histories are still stored per account for now. Moving those is a bigger and riskier job, because live sessions are writing to them and some conversations have diverging copies in different accounts. That work is tracked as a separate commitment (CMT-596).

Nothing needs deciding.
