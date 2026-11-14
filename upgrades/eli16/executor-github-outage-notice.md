# Saying so when GitHub access stops feedback fixes

Feedback fixes need GitHub: a worker reads the repository, publishes its proposed fix, and follows it through review and merge. When the agent's GitHub access stopped working, the executor correctly stopped starting new fixes and wrote "github-unavailable" in its status. The problem is that nobody is told. No attempt fails, so none of the failure alerts fire, and reports keep arriving and being sorted, so everything looks busy. That's how fix delivery sat stopped for more than a day until someone asked.

Now, if the outage lasts two hours, the executor raises one attention item saying fixes have stopped, that reports are still being collected, and that it recovers by itself when access returns. It points first at the agent's saved GitHub credential, the usual cause. The two hours keep brief GitHub problems quiet. It alerts once per outage rather than on every run, and a later outage gets its own wait and its own notice.

This only adds a notice. It doesn't change what the executor does during an outage, and it doesn't approve, block or start anything. Nobody has a decision to make because of this change, and undoing it is a plain revert that leaves one small unused record behind.
