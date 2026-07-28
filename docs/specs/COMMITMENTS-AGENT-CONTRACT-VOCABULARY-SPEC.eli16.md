# Commitments Agent Contract Vocabulary ELI16

Commitments already work, but the instructions agents read had the wrong recipe.

They said to create a follow-up with `type:"follow-up"` and did not include what the agent promised to do. The server rejects that. The real type for this is `one-time-action`, and the server also needs `agentResponse`.

This fix updates the instructions and adds tests so future agents learn the working shape. A promise starts as `pending`; when the agent comes back and marks it done, it becomes `delivered` and stops its reminder beacon.
