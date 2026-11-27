# Project placement in the owner conversation list

The existing owner-scoped list adds the nearest confirmed project conversation
key for rows with readable ancestry. The project conversation itself has the
same key. Saved groups are independent of these assignments. Incomplete
project evidence, unreadable paths and cycles cannot invent membership.
No storage, bindings, group routes, or write behavior changes.

## 6b. Operator-surface quality

An owner client can place confirmed project chats under their project even
when the saved group graph has no usable groups. Omitted membership alone
cannot establish that a chat is ungrouped.

## Framework generality

The projection uses canonical conversation references and existing owner
admission independently of device platform.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-27 14:36 PT, read only, over the whole PR 3921 (which carries every PR 3916 commit) merged with main faf70e25d. Verdict: CONCUR WITH CHANGES.

It found privacy and authority sound (owner session admission on /conversation-graph/tree, refs filtered by viewer visibility, projectConversationKey only for owner scope), the main merge clean, no ratchet flags, and the touched tests passing by hand trace. Applied: its must-fix in src/core/ownerTreeProjectMembership.ts, where a chat nested under a non-project root (for example under the Chief of Staff topic or an unconfirmed project) got no membership entry, so placementComplete came out false for ordinary trees; such a chat is now placed outside every project at any depth, and only an invisible or unknown ancestor withholds placement (new case in tests/unit/owner-tree-project-membership.test.ts). Recorded, not changed: when placementComplete is false, sections.projects and sections.groups are still sent partly filled, so clients must render no sections then and keep their existing display (as docs/specs/work-front-doors.md already requires); proposed card rows under a group are not cross-checked against the other sections; and completeness is all-or-nothing for the whole tree, a candidate per-project follow-up.
