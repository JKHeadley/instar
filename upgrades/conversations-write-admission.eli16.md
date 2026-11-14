# Conversations works on every machine (plain overview)

**What this is.** Conversations is the page where you see your efforts and the conversations behind them. If an agent runs on more than one machine, those machines have to agree on one shared list. To do that, each machine needs a small safety layer called write admission. It checks who is allowed to write shared state.

**What went wrong.** Write admission was still treated as an experiment. It was switched on only for development agents, and on Echo only on the Studio, because the Studio is the one machine marked as a development machine. Every other machine had it off. When the Studio asked the others to start the shared list, they all said no, and the page stayed stuck on "this machine has not joined your other machines yet". For a normal user with two machines, it would never have worked at all.

**What changes.** When Conversations is on, each machine now switches write admission on by itself, in watch-only mode. In that mode it only records what it would have done. The older safety check keeps doing the real enforcing, exactly as before. If someone has turned write admission off on purpose, that choice still wins.

**The second fix.** Some conversations have no title. The list showed them all as "Conversation", which tells you nothing. Now a Telegram topic shows as "Topic 141868", the same name the chat list already uses, and you can search for it by that name.

**Safeguards.** Nothing new can block anything. Watch-only mode cannot refuse a write. Undoing the change is a plain revert, with no data to repair.

**What to decide.** Nothing. This is a small fix, and it was already shown working live on Echo's five machines by switching the same setting on by hand.

**Update, 13 November.** An untitled topic now shows its real name when the agent knows it from the topic list. When it does not, the row says "Topic 141868 (name unresolved)" rather than a bare number.
