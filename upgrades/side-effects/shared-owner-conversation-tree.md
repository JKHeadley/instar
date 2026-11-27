# Shared owner conversation tree read

The dashboard can request the same bounded graph tree used by signed mobile
owners. It uses existing dashboard operator proof. A service bearer alone
cannot open the tree. The route rechecks the grant before returning content
and uses the existing read model, cursor and readiness handling.

## 6b. Operator-surface quality

The dashboard can read nested saved groups in one request and report
incomplete or unavailable data through the same fields as mobile.

## Framework generality

The same projection serves desktop and mobile with their existing
authentication rules.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-27 14:36 PT, read only, over the whole PR 3921 (which carries every PR 3916 commit) merged with main faf70e25d. Verdict: CONCUR WITH CHANGES.

It found privacy and authority sound (owner session admission on /conversation-graph/tree, refs filtered by viewer visibility, projectConversationKey only for owner scope), the main merge clean, no ratchet flags, and the touched tests passing by hand trace. Applied: its must-fix in src/core/ownerTreeProjectMembership.ts, where a chat nested under a non-project root (for example under the Chief of Staff topic or an unconfirmed project) got no membership entry, so placementComplete came out false for ordinary trees; such a chat is now placed outside every project at any depth, and only an invisible or unknown ancestor withholds placement (new case in tests/unit/owner-tree-project-membership.test.ts). Recorded, not changed: when placementComplete is false, sections.projects and sections.groups are still sent partly filled, so clients must render no sections then and keep their existing display (as docs/specs/work-front-doors.md already requires); proposed card rows under a group are not cross-checked against the other sections; and completeness is all-or-nothing for the whole tree, a candidate per-project follow-up.
