# Why Codex agents could never resume a conversation

These AI agents can be paused and later picked back up where they left off. To
pick a conversation back up, the agent first checks that the saved record of
that conversation still exists on the computer. If the record is there, it
resumes; if not, it assumes the conversation is gone and starts fresh.

The check for that record only ever looked in ONE place — the folder where
Claude-based agents keep their conversation files. But agents built on a
different engine called Codex keep their conversation files somewhere completely
different, organized into folders by date. So whenever a Codex agent tried to
pick a conversation back up, the check looked in the Claude folder, found
nothing, and wrongly concluded the conversation was gone. The Codex agent could
never resume — it always started over and lost the thread, even though its
record was sitting right there in the Codex folder the whole time.

The fix teaches the check to look in BOTH places. It still looks in the Claude
folder first, exactly as before, so nothing changes for Claude agents. But if it
does not find the record there, it now also looks in the Codex folder — walking
the date-organized layout to find the matching conversation file. If the record
exists in either place, the agent resumes correctly.

For an agent that only uses Claude, the extra Codex look-up costs essentially
nothing: the Codex folder does not even exist, so the check notices that
instantly and moves on. For a Codex agent, it finds the record where it actually
lives, and resume finally works.

This reuses the same Codex file-finding helper the system already uses elsewhere
to track how many tokens a Codex agent has spent, so it is not new or untested
machinery — it just points the resume check at the Codex layout it was always
missing. The change only touches the one check that asks "does this conversation
record still exist"; everything else about how resume works is untouched.
