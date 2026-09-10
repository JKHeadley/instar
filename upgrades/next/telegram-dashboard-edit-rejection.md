# Keep a held dashboard refresh from creating another post

When a pinned dashboard-link edit is held or its delivery is uncertain, Instar now
keeps the original message ID and reports the failed refresh. It no longer turns
that failure into a brand-new dashboard post. This reduces the extra sends that
can accumulate during repeated tunnel restarts.

A confirmed missing pinned message can still be replaced, and an unchanged link
remains a quiet no-op. Origin recording, ownership, capacity limits and recovery
budgets remain in force. This patch does not fix false wake detection or guarantee
delivery of a held message.

Existing agents receive the correction through their normal update and server
restart. No configuration change or queue reset is required.
