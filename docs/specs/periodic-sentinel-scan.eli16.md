# Periodic activity-digest scan — ELI16

## The short version

Your agent already does two things automatically: it writes short summaries of chunks of its work, and it pulls the durable facts out of those summaries into a searchable memory graph. The catch: until now it only did this when a conversation ENDED.

Long conversations — the ones that run for hours, span days, or never cleanly finish because of a restart — never got summarized. All that work, all those decisions, never reached the memory graph. Which is backwards, because the long important conversations are exactly the ones worth remembering.

This change adds a timer. Every 30 minutes, the agent summarizes whatever in-progress conversations have new activity and feeds the durable facts into its memory graph. The graph now grows throughout a long conversation, not just at the very end.

## Why it matters

The whole point of the recent memory work is to stop the agent's knowledge graph from sitting empty. The previous change taught the agent to extract facts from its work. But that extraction only ran at the end of a conversation. For a months-long client engagement (the kind of conversation that started this whole effort), "the end" might be never. So the extraction never ran for the conversations that needed it most.

The timer fixes that. It's the last piece of getting the graph populated before the bigger feature (keeping the agent aware of the big picture in a long conversation) gets built on top.

## What you'll notice

Nothing immediately. The scan runs quietly in the background every 30 minutes. Over a long conversation you'll see the agent's memory of that conversation get richer — it'll recall decisions and facts from earlier in the same conversation without you having to remind it.

It's on by default. If you ever wanted it off or on a different schedule, that's a one-line setting, but the default (every 30 minutes, on) is right for almost everyone.

## Safety

The scan is careful about cost: it skips conversations with no new activity, and it won't summarize a conversation that has too little new content to be worth it. On a multi-machine setup, only the active machine runs the scan, so you never pay for the same work twice. And if a scan ever fails, it's logged and the agent keeps running — a failed summary never takes the agent down.
