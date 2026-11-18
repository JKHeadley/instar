# Cards from this conversation

<!-- bump: patch -->

## What Changed
The dashboard Conversations page shows cards created from that conversation, initially three with explicit expansion and paging. Exact source filtering happens before ordinary board limits. Removed cards stay absent, and only the owner or bearer caller may read source associations. Cards beyond board limits open through the existing single-card reader.

## What to Tell Your User
Cards you made from messages now appear with the original conversation. Open one to see its Work details. If the list changed while you were reading, reload it to get the current list.

## Summary of New Capabilities
GET /work-board and /mobile/work-board accept optional sourceConversationKey and sourcePage, returning cards, total, nextPage, newestHlc, sourceRevision and behind. Existing unfiltered board reads are unchanged. Native app rendering is delivered separately by its owner.
