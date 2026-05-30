# Threadline Stale Thread Retirement - Plain-English Overview

Threadline is the part of Instar that lets agents keep a relationship over time instead of treating every message as brand new. That persistent relationship is useful, but it also means the system has to know the difference between a live conversation and old conversation history. Echo noticed that Codey had a much higher active thread count than the other agents. That was a strong sign that old relay threads were staying marked active even after the useful exchange was over.

The change is deliberately conservative. It does not delete conversations. It only moves old, quiet conversations out of the active set and into the archived state after a full day with no activity. The thread history and metadata stay on disk, so a later reply can still pick up relationship context. Pinned conversations are never retired by this rule because pinning is the local signal that a thread should stay visible even if it is quiet.

This is implemented at the storage layer, where Threadline conversations already live, and then called from the active-thread views. That avoids adding a new background worker or timer that could be harder to reason about. Whenever the system asks for active Threadline conversations, it first performs the small cleanup pass and then returns the view. The active-agent metric is also corrected so idle conversations do not count as active work.

The practical result is simple: old Threadline conversations stop inflating active counts, while relationship memory remains intact. The user and other agents get a cleaner view of what is really active, and the system keeps the ability to resume a relationship if the other side comes back later.

The main safety point is that this is archival, not deletion. A too-aggressive cleanup rule would be dangerous if it erased history. This one only changes the state of stale, non-pinned records and leaves the data available for future handling or inspection. Tests cover stale active retirement, stale idle retirement, pinned-thread preservation, fresh-thread preservation, and the corrected active count.
