# Activity-digest entity extraction — ELI16

## The short version

Your instar agent already writes a short summary of every chunk of work — what happened, what was learned, what mattered. Those summaries are useful but isolated; each one lives by itself and can't be searched, connected, or reused.

This change asks the same summary-writing model to ALSO pull out the durable things worth remembering: the people involved, the projects, the decisions made, the lessons learned. Each one gets a name and a short description, and any obvious relationships between them ("this decision is part of that project") get recorded too.

The agent's knowledge graph then grows automatically as the agent works. Over time, every important person, project, decision, and pattern the agent encounters becomes searchable and connectable. The next session inherits a richer awareness than the last.

## Why it matters

Before this fix, instar shipped a typed knowledge graph (SemanticMemory) but the only way to put things in it was a one-shot migration from existing flat-file memory. Once the migration ran, the graph stopped growing. Every new conversation, every new decision the agent made, every lesson learned — all of it landed in conversation logs but never in the structured graph the agent actually queries when it needs to remember.

Now the graph grows with the work. A digest about "the Egnyte refresh-token rotation decision" doesn't just become a paragraph in the activity log — it becomes a typed `decision` entity in the graph, connected to the `fact` entity about token rotation, connected to the `project` entity for the client engagement. Future sessions asking about Egnyte get all three back.

## What you'll notice

For most agents, nothing immediately. The pipeline runs quietly in the background as the activity sentinel scans sessions. Over days the graph fills out. The first visible effect will be richer context at the start of new sessions — your agent will know about more of its own prior work without needing to dig through transcripts.

If the language model can't extract entities cleanly from a particular chunk (some chunks are mostly noise), the digest still saves with an empty entity list. The summary record stays useful regardless. Nothing breaks.

## What the change does NOT do

It does NOT change the digest summary, actions, or learnings fields. It does NOT enable cross-topic retrieval (that's a later phase). It does NOT change anything about how the agent writes responses or makes decisions today. The change is purely about populating the graph that other systems can then query.

## When the value shows up

The graph compounds. After the first few scans of an active topic, expect dozens of entities. After a week of normal use, expect a few hundred. At that point retrieval-against-the-graph starts to be genuinely useful — the next phase of work (Topic Intent Layer) reads from this graph, and the richer it is, the better that layer performs.
