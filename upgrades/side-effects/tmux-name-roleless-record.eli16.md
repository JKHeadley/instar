# A respawned session keeps its own name

Every agent session runs in a terminal window with a name. A recent change (in PR 3426) made sure two different jobs or conversations never share one window name, by giving the second one a numbered name such as "build-2".

That rule was a little too strict. When a session first started with no conversation attached and was later restarted for a conversation, under the very same name, the rule saw the old record as "someone else" and handed the restart a numbered name. The restarted session then lived in a different window than before, and anything looking for it by its old name (in this case an automated test) could not find it.

The fix: a past session that had no conversation and no job, and has exactly the same name, is treated as the same session, not as someone else. Everything else about the rule stays as it was, so two real conversations still never share a window name.

What needs deciding: nothing.
