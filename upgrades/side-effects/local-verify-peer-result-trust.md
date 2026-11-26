# Side effects: signed peer results and bounded peer authority on main (SEC-113)

Tier 2 (security, gates merges). Spec: docs/specs/local-verify-peer-result-trust.md, converged at round 6 (Tier 2 cap; security, integration and cross-model reviewers all at design 0). Size: 2 new modules, about 400 lines in LocalVerifyService, a route, a console card, wiring, registry and awareness; 4 new or changed unit files plus updated integration and e2e suites.

## What changes for running agents

- **Every agent with Local Verify peers configured (D1, live)**: a peer signs its answers; the coordinator refuses an unsigned, mis-signed, wrongly-bound or unpinned answer and runs that verify itself. A peer whose current signing key is not pinned on the coordinator is skipped before dispatch (audited `peer-unpinned` once per boot). Mixed versions never meet: the signing module is inside the verifier-version graph, so a pre-change peer is already refused by the version check. A version or policy skew now abandons without counting toward the peer's breaker.
- **Peer PR records** are still imported, but their flaky lists no longer feed flaky history or flaky items.
- **Agents with `mainOnPeers` on (D2)**: a peer's main green no longer becomes the isolation baseline; the coordinator keeps main local until it has its own green and ten measured main runs, re-checks main itself once the commits only peers checked reach the refresh age, and main turns suspect at most 3 h after the first merge it has not verified. Expect `mainKeptLocal` main verifies on the coordinator (shown in `GET /local-verify` → `peers.trust`).
- **Every Local Verify coordinator**: the green-main record must carry `origin: 'local'`, so after this upgrade isolation re-runs wait for the next local main green (usually within the hour). With `mainOnPeers` on, release-commit collapsing counts only heads this machine recorded a main verdict for; with it off, collapsing and retargeting are unchanged.
- **New state**: `state/local-verify/peer-trust.json` (registered machine-local, bounded), reset whenever holding by this machine is broken; a restart while holding keeps it.
- **New route**: `POST /local-verify/peers/:machineId/main-quarantine/clear`, operator session only (503 if the check is not wired, 401 on Bearer alone, 409 on a standby).
- **New attention items**: `local-verify:peer-result-unverified:<machine>` (closes on the next verified answer) and `local-verify:peer-main-disagreement:<machine>` (closes on Clear, or with plain words on lease loss or restart-with-gap).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The one operator surface is a card on the console's Development page (`dashboard/console/development.js`, `keptOffMainCards`).
1. **Leads with the primary action?** Yes. The card appears only while a helper machine is kept off main, sits at the top of the page above every fold, and its one button, "Let it test main again", is the action the owner came for.
2. **Zero raw internals as primary content?** Yes. The title and text are plain words ("A helper machine no longer tests main"); the machine id appears only on a muted "Machine:" support line. No hashes, heads or JSON are shown.
3. **Destructive actions de-emphasized?** Not applicable: there is no destructive action. Clearing restores a machine's ability to test main; the PIN unlock guards it.
4. **Plain language + phone width?** Yes. The card reuses the page's existing need-card and inline-button styles, which already stack at phone width; it is checked at 1280x728 and 390x844 before the release notes are shipped, per the spec.

## Where the numbers come from

- **3 h** is not new: it is the existing `MAIN_HEALTH_LIMITS.unverifiedSuspectMs` floor from the merge-authority spec, after which an unverified main stops merges. This change only stops peers from resetting it.
- **The refresh age** is not a fixed number: it is that 3 h floor minus 1.5 times this machine's own measured p90 local main duration (capped at 2.5 h), so a local check started then normally finishes inside the floor. On a machine whose own runs are too slow, peers never serve main.
- **Ten runs** is the smallest sample where the 90th percentile is not simply the slowest run. Until it exists the coordinator has no measurement, so main stays local, the conservative side of the floor.

## Signal vs authority

The signature check and the routing rules only refuse a peer's answer or keep work local; neither adds authority to block a PR. Arbitration results never reach main health. The owner's Clear is the only way back for a quarantined peer, behind the operator session.

## Rollback

Revert. Older builds ignore `peer-trust.json` and the `origin` field. After a revert, peer greens write the green-main record again and peer answers are imported unsigned, as before. Open items stay until resolved by hand.

## Multi-machine posture

Lease-holder state beside the LV queue and peer state it extends (operator-ratified exception of the parent capacity spec, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17). A lease move starts the new holder with no anchor, so main stays local until its own green.

## Not covered here (tracked under SEC-113 in the security ledger)

R1: a peer's PR green still merges a PR on that peer's word (the parent spec's design). R2: the pool Bearer token travels in clear on the LAN hop. R3: a lying peer can make main suspect until one local rerun. The arbitration attempt is a peer vouching for a peer; it restores bounded authority only.

## Second-pass review
**Reviewer:** independent read-only code review subagent (fresh context, ran six unit files). Round 1 found no way past the signature (every import path is checked after the field checks and before any use; arbitration never reaches main health; the signed and acted-on bytes agree) and objected to one un-updated integration test, now fixed. Its non-blocking notes were taken: every disagreeing peer is told, the two-read rule resets on a not-held read, collapse and retarget keep today's behaviour when `mainOnPeers` is off, a null epoch read decides nothing, the unverified item closes after a restart. Round 2 concurred. Left as stated: arbitration skips `peerFit` (a busy peer answers peer-busy), and the boot window before the first tick (main health already blocks peer main after a holder change).
