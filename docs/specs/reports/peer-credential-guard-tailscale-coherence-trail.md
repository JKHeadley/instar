# Reasoning trail — peer-credential-guard-tailscale-coherence

Moved out of the spec in round 7. The skill's own convergence analysis notes that a spec which
appends its own review history grows its reviewable surface every round, so a diligent reviewer
will always find more precision to add and the loop cannot terminate by construction. The trail
is preserved here in full — it is the most useful artifact of the review — while the spec itself
stays the design document a reviewer is asked to judge.

## 9. Reasoning trail — what review changed, and why

Kept because the errors are the useful artifact. Six rounds; one external family (codex) plus
the constitutional gate.

### 9.1 Optional kind -> required (round 1)
The draft made `kind` optional, leaving 19 of 20 call sites untouched, and called that small
blast radius. All 20 are credential-bearing pool paths, so the bug would have **stayed live
on 19 of its 20 routes** — an unfixed bug dressed as a virtue. The justification also leaned
on the anti-divergence ratchet catching a forgotten argument; that ratchet inspects regexes
and imports and **cannot evaluate an omitted parameter**. A required field makes it a compile
error: Structure > Willpower, where the draft had a willpower answer in a ratchet's clothes.

### 9.2 Multi-machine posture was factually wrong (round 1)
The draft called endpoint records "unified (proxied-on-read), each machine reads the same
advertised endpoint set." The parent spec says the opposite in writing: peer `endpoints` are
"**machine-local BY DESIGN** ... NOT replicated and NOT proxied-on-read," because
"reachability is observer-relative." Corrected in section 10; the consequence (observers hold
different/stale sets) is now tested.

### 9.3 Encryption and token-scope claims withdrawn (rounds 1-2)
"Tailscale encrypts it" and "a peer-pool read credential" were both false. See 4.2.

### 9.4 Impersonation does not collapse into the paired-peer case (round 3)
An impersonating responder can present the expected `machineId` without compromising the
paired machine. This moved CGNAT admission from default-on to default-off.

### 9.5 The first inversion (round 4)
Measuring the *full* rope set showed two of three Studio ropes already admissible, so the
Tailscale widening was solving a problem that did not require it.

### 9.6 Removing the widening entirely (round 5)
The conformance gate flagged the default-off flag three consecutive rounds: it still
*permits* full-credential egress on a premise the spec itself documents as unverifiable.
Removed outright rather than parked behind a flag.

### 9.7 Admission is not reachability — the previous fix would not have worked (round 5)
The sharpest finding. "Return the first *admitted* rope" treats admission (a symbol) as
proof of reachability (the state) — the exact error pattern this project's own P20 standard
names, committed inside my own fix. Measurement settled it: the Studio's LAN rope is
**admitted and unreachable** from this machine, while cloudflare works. A first-admitted-wins
fallback would have shipped as a non-fix. 3.4 is now connection failover with health
feedback, and 5 contains the test that fails on a first-admitted-wins implementation.

### 9.8 The gate on CGNAT admission was itself insufficient (round 5)
4.3 originally named only authenticated pull-response provenance. That addresses forged
advertisements but leaves 4.2's stale-address and routing-change cases — which involve no
forgery — untouched. The gate now requires authenticating the **destination**, not the
record.

### 9.9 Found by building, not reviewing: the resolver already solved this
The decisive insight was not a reviewer's: reading `PeerEndpointResolver`'s own docstring
showed it already produces the ordered, health-aware candidate list this fix needs, and that
`resolveMeshPeerUrl`'s `[0]?.url` discards it. The fix shrank from "add failover" to "stop
throwing away the failover we already have." Recorded because it is the inverse of 9.1-9.8:
reviewers caught what I over-claimed; reading the subsystem caught what I was about to
rebuild.

