# Side-effects review: pool reads name each machine from THIS machine's registry

## Change
`src/server/routes.ts`, three pool merges (`GET /sessions?scope=pool`, `GET /jobs?scope=pool`, `GET /attention?scope=pool`): a peer row's `machineNickname` now comes from this machine's registry first (`machinePoolRegistry.getCapacity(id).nickname`), and the peer's self-reported name is the fallback (it was the other way round). For attention items, a title the peer prefixed with its own name (`"<own>: …"`) is re-prefixed with the registry name when the two differ.

## Evidence
On the Studio (2026-11-02) `GET /pool` named `m_a8048693…` "Mac M5 Pro" (the Studio's durable registry), while that machine's own attention items arrived as "Mac Lan: Remote Desktop needs its Mac permission again" with `machineNickname: "Mac Lan"`. The dashboard showed the same machine under two names (Machines page vs needs-you).

## 1. Over-block
None.

## 2. Under-block
Free text inside a body that names the peer is not rewritten. The registries themselves still disagree across machines (machine registry is not shared on a git-ignored registry); which name is correct is the operator's call. `PATCH /pool/machines/:id` updates only the local registry, so a rename applies to this machine's dashboard only (filed separately).

## 3. Level-of-abstraction fit
The merge is where rows from several machines are composed for one viewer; naming there keeps every page consistent without per-page fixes.

## 4. Signal vs authority
No decision logic; display data only. Routing uses `machineId`, unchanged.

## 5. Interactions
P17 coalescing keys on `sourceContext`, not title or nickname: unchanged. Rows from this machine are unchanged.

## 6. External surfaces
Pool API rows carry the viewer's name for a machine. A peer with no registry entry here keeps its own name.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
Each machine has one name across the Machines page, needs-you rows, sessions and schedule, so the operator never wonders whether "Mac Lan" and "Mac M5 Pro" are two machines.

## 7. Multi-machine posture
Proxied-on-read: each viewing machine names peers from its own registry. Registry convergence across machines is separate.

## 8. Rollback cost
Revert.
