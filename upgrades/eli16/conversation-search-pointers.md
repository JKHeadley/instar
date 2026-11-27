# Finding earlier conversations

When you ask whether we discussed something before, the agent now starts with conversation search. It can look through captured app, Telegram, and Slack messages it has access to and ask the agent's other machines to search their copies. It checks whether the search covered all the sources before reporting what it found. If conversation search is unavailable, the agent can check captured Telegram history.

The old instructions often sent the agent to a search that reads a small set of memory files. That explains how the agent could say it found nothing about permanent agent links while the earlier conversation was still there. Pull requests, branches, specs, and work cards have their own records, so the agent checks those when the question is about work that may already exist.

The search used by the older memory and Telegram routes now accepts text such as `instar.sh`, `SEC-123`, and contractions. A hyphen could previously produce an error and a dot could make an existing result disappear. Existing agents get the corrected instructions when they update.
