# Placement history survives an ordinary restart

Instar records which subscription account it chose when it starts a session. That history lets operators see whether better placement actually used more of the available quota. An empty logging pass could leave new records waiting in memory indefinitely. Now each placement starts an asynchronous write, and a graceful shutdown lets outstanding placement records finish before the process exits. Account selection follows the same rules, and the new write does not block a session start.

Before this change, the server also left the final buffer behind when it shut down through its normal path. The account history could therefore undercount sessions even though the sessions themselves started correctly. The existing restart marker still flags possible missing records after an unexpected stop. Operators can use that marker to distinguish an incomplete history from a confirmed count.
