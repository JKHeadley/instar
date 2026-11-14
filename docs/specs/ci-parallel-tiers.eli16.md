# Start independent CI test jobs together

GitHub currently waits for every unit-test shard to finish before it starts integration and end-to-end tests. Those later jobs use their own fresh checkouts and runners. They do not consume an artifact from the unit jobs. On a real PR, the unit shards took about half an hour, and the later tests could only begin afterward, even though a separate Mac Mini had already passed all three tiers.

Start the integration and end-to-end jobs when the workflow starts, alongside the unit shards. Every test result remains a required merge check. A broken unit test will no longer save the cost of running the other two jobs, but a green PR should reach its final CI verdict sooner when GitHub has enough runner capacity.
