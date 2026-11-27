# Explicit owner tree sections on the disposable fixture

The shared read model can return Projects, Groups and Ungrouped. It requires
affirmative project membership coverage and complete graph evidence before
marking placement complete. Ambiguous, missing, overlapping, or truncated
placements keep the completeness flag false and omit ungrouped candidates.

The production adapter does not supply this authority yet. The disposable
launcher supplies exact project membership and exercises the same signed
tree read. This checkpoint leaves live clients on their current display.

## 6b. Operator-surface quality

The signed fixture allows clients to verify the three sections before they
enable the new layout on a live connection.

## Framework generality

Both owner routes use the same output without platform-specific placement.

The signed fixture also seeds a project descendant pin through the real pin store.

The fixture joins a visible card to the exact same conversation across signed list, Projects and tree reads.

The disposable launcher serves signed read-only board and exact card detail data with a conversation backlink.

The production tree now reads project membership from the Chief placement
snapshot for conversations visible in the certified graph. It recognizes
confirmed project chats, direct children and explicit roots. Unknown ancestry,
invisible parents, and deeper project paths that this renderer cannot yet
preserve withhold completeness. This is a partial integration checkpoint.

The tree preserves the exact parent of a generated descendant within the
same project. The signed test places a linked card under the generated
parent. Missing, cyclic, or out-of-budget edges withhold completeness.

Complete project branches expose a visible descendant conversation count excluding the project chat itself.

A parentless Telegram topic in covered inventory has affirmative negative project placement. App rows still require explicit root or ancestry evidence.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-27 14:36 PT, read only, over the whole PR 3921 (which carries every PR 3916 commit) merged with main faf70e25d. Verdict: CONCUR WITH CHANGES.

It found privacy and authority sound (owner session admission on /conversation-graph/tree, refs filtered by viewer visibility, projectConversationKey only for owner scope), the main merge clean, no ratchet flags, and the touched tests passing by hand trace. Applied: its must-fix in src/core/ownerTreeProjectMembership.ts, where a chat nested under a non-project root (for example under the Chief of Staff topic or an unconfirmed project) got no membership entry, so placementComplete came out false for ordinary trees; such a chat is now placed outside every project at any depth, and only an invisible or unknown ancestor withholds placement (new case in tests/unit/owner-tree-project-membership.test.ts). Recorded, not changed: when placementComplete is false, sections.projects and sections.groups are still sent partly filled, so clients must render no sections then and keep their existing display (as docs/specs/work-front-doors.md already requires); proposed card rows under a group are not cross-checked against the other sections; and completeness is all-or-nothing for the whole tree, a candidate per-project follow-up.
