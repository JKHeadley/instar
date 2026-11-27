# Disposable native conversation tree launcher

Runs the existing signed owner routes on an ephemeral loopback port. Only
the caller's synthetic P-256 public key is registered. The listener allows
three GET routes and refuses other requests. Group, project and conversation
data are synthetic and live in a temporary directory removed on shutdown.

## 6b. Operator-surface quality

Apple can capture the native views while the signed fixture remains running.
The fixture covers a project independent of saved groups, generated ancestry,
a hidden worker, an ordinary chat and a nested saved group. It is not a
production or real-owner acceptance result.

## Framework generality

Any client that implements the existing signed request format can use the
loopback fixture with a disposable key.

The launcher primes the existing asynchronous creation projection for its
single disposable owner before announcing readiness. The first signed pool
read now exercises the generated child's exact parent. Live router cache
behavior is untouched.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-27 14:36 PT, read only, over the whole PR 3921 (which carries every PR 3916 commit) merged with main faf70e25d. Verdict: CONCUR WITH CHANGES.

It found privacy and authority sound (owner session admission on /conversation-graph/tree, refs filtered by viewer visibility, projectConversationKey only for owner scope), the main merge clean, no ratchet flags, and the touched tests passing by hand trace. Applied: its must-fix in src/core/ownerTreeProjectMembership.ts, where a chat nested under a non-project root (for example under the Chief of Staff topic or an unconfirmed project) got no membership entry, so placementComplete came out false for ordinary trees; such a chat is now placed outside every project at any depth, and only an invisible or unknown ancestor withholds placement (new case in tests/unit/owner-tree-project-membership.test.ts). Recorded, not changed: when placementComplete is false, sections.projects and sections.groups are still sent partly filled, so clients must render no sections then and keep their existing display (as docs/specs/work-front-doors.md already requires); proposed card rows under a group are not cross-checked against the other sections; and completeness is all-or-nothing for the whole tree, a candidate per-project follow-up.
