---
title: Pool-scope reads dead-end because selection never checks admissibility — filter at selection, feed the health map, name the CGNAT refusal honestly
slug: peer-credential-guard-tailscale-coherence
date: 2026-10-22
author: echo
status: approved
approved: true
approved-by: "Justin (Telegram topic 127831, 2026-10-22 — 'approved, please proceed')"
approval-note: >
  Operator-ACCEPTED, not criteria-met. He approved after being shown the convergence
  report stating plainly that this spec did NOT meet /spec-converge's two-clean-rounds
  bar (18 rounds vs a cap of 10), ran against ONE external family (codex; gemini absent)
  whose verdict never cleared, and carries an open accepted Know-Your-Principal residual
  (4.1.1) that is disclosed and NOT closed. The review-convergence tag records that the
  skill RAN and that the report exists; it does not assert the criterion was satisfied.
  The design was stable and defect-free from round 12 — the churn was author claim hygiene.
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: peer-credential-guard-tailscale-coherence.eli16.md
tracks: "topic 127831 · operator directive 2026-10-21 'an INSTAR agent should act as a single coherent agent, regardless of what machine processes are running on'"
review-convergence: "2026-10-22T02:51:20.621Z"
review-iterations: 18
review-completed-at: "2026-10-22T02:51:20.621Z"
review-report: "docs/specs/reports/peer-credential-guard-tailscale-coherence-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Pool-read selection fix + host-trust consolidation

> **Third restructure (round 6).** Each round moved this further from its first shape, and
> the final shape is the smallest. Round 5 proved the previous fix **would not have worked**:
> it stopped at the first rope the credential guard *admitted*, and on this fleet that rope
> is admitted-but-unreachable. Section 9 keeps the full reasoning trail, because the
> sequence of errors is the most useful artifact this review produced.

## 0. Constitutional traceability

**Parent principle:** *Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions*
(a named, live subsection of *An Instar Agent Is Always a Multi-Machine Entity*).

The fit is the article's own In-practice clause, quoted rather than paraphrased so the fit can be
checked:

> "Cross-machine paths resolve peers by their advertised internet (tunnel) URL; a LAN address is
> only an opportunistic fast-path overlay that **must degrade cleanly to the internet path** — the
> operational sub-standard *'LAN is an Optimization, Never a Dependency'* hangs here."

That is precisely the defect. `resolveMeshPeerUrl` hands the fan-out ONE rope — the
highest-ranked, which on this fleet is a tailnet or LAN address — and when the credential guard
refuses it the read **dead-ends instead of degrading to the tunnel path that was sitting right
there and already admissible**. A LAN/tailnet rope was operating as a dependency, not an
optimization. The fix restores clean degradation by selecting the best *admissible* rope, which is
this article's rule applied at the selection point.

Secondary, not claimed as the anchor: *Verify the State, Not Its Symbol* governs §12.1 (admission
is not reachability — the error that made an earlier draft of this fix a non-fix), and *A Refusal
Stays a Refusal* governs keeping `url-rejected`, `peer-unreachable` and `no-known-url` distinct.

## 0.1 Tracked deferral carrier (frozen excerpt) <!-- tracked: CMT-013 -->

Every `<!-- tracked: CMT-013 -->` marker in this document resolves to a real, durable commitment
with a follow-through beacon — not a comment and not a typed-in promise. Its immutable text is
inlined here so a reviewer can check the carrier actually covers the deferral without needing API <!-- tracked: CMT-013 -->
access:

> **CMT-013** — Registered follow-up for peer-credential-guard-tailscale-coherence section 4.3: <!-- tracked: CMT-013 -->
> move pool peer reads off the shared agent bearer token onto machine-auth AND add DESTINATION
> authentication — recipient, method and request-target binding plus authenticated responses.
> Request signing alone authenticates only the SENDER, so it is a prerequisite and NOT a
> substitute. This is the gate on ever admitting Tailscale CGNAT plaintext or plaintext-rope
> failover. Feasible as a single chokepoint: authMiddleware is mounted globally.

Opened against topic 127831 with `owner: agent`, `blockedOn: none` and a 7-day
`nextUpdateDueAt`, so the PromiseBeacon re-surfaces it until it is delivered or deliberately
withdrawn. That is what makes the deferral in 4.3 a tracked obligation rather than an intention. <!-- tracked: CMT-013 -->

## 1. Problem

### 1.1 The user-visible defect

From the standby machine, every cross-machine read dead-ends:

```
GET /threadline/peers/health?scope=pool
-> pool.failed: [ {m_03b3..., "url-rejected"}, {m_4cbc..., "url-rejected"} ]
   peersQueried: 0, peersOk: 0
```

### 1.2 Root cause — a one-line lossy adapter

`PeerEndpointResolver` exists precisely to produce, per its own docstring, an "ORDERED,
VALIDATED, CAPPED candidate list for the hedged failover transport," tracking
"per-(peer,kind,url) health so the order is latency+liveness-aware and a dead rope is
deprioritized-but-probed," with `recordResult()` feeding outcomes back.

`src/core/resolveMeshPeerUrl.ts` then throws all of that away:

```ts
return resolver.resolve(machineId, endpoints, lastKnownUrl)[0]?.url ?? null;
```

`[0]?.url` discards **every alternative rope** and **the endpoint kind**. `peerUrl()` in
`commands/server.ts` wraps this helper, `_resolvePeerUrls()` wraps `peerUrl()`, and the pool
fan-outs then plain-`fetch` that single URL. So the fan-outs get:

- **one rope**, with no failover,
- **no kind**, so the credential guard cannot reason about or name what it refused,
- **no `recordResult()` feedback**, so rope health never learns from pool traffic.

The hedged failover transport (Layer 2) consumes the list correctly. The pool fan-outs
bypass it through this adapter. **That is the defect.**

### 1.3 Two measured facts that shape the fix

**(a) The credential guard refuses Tailscale CGNAT.** `isPrivateOrLocalHost` in
`src/server/peerUrlGuard.ts` covers loopback, RFC-1918 and IPv6 ULA/link-local, but not
`100.64.0.0/10`. Run against the compiled guard:

```
{"ok":true}                                http://localhost:4040
{"ok":true}                                http://127.0.0.1:4040
{"ok":true}                                http://[::1]:4040
{"ok":true}                                http://[fc00::1]:4040
{"ok":true}                                http://[fe80::1]:4040
{"ok":false,"reason":"scheme-not-allowed"} http://169.254.169.254/      <- metadata already refused
{"ok":false,"reason":"scheme-not-allowed"} http://100.64.0.1:4042       <- the refused range
{"ok":true}                                http://172.31.255.255:4040   <- RFC-1918 upper boundary
{"ok":false,"reason":"scheme-not-allowed"} http://172.32.0.1:4040       <- just outside, correctly refused
{"ok":false,"reason":"scheme-not-allowed"} http://8.8.8.8:80            <- public http correctly refused
```

**(b) Admission is NOT reachability — and conflating them is what made the previous fix
wrong.** The Studio's full rope set, from the standby machine, guard verdict beside actual
connectivity:

| kind | URL | guard | actually reachable from here |
|---|---|---|---|
| tailscale | `http://100.124.55.70:4042` | refused | not attempted |
| lan | `http://192.168.87.47:4042` | **admitted** | **NO** — `HTTP 000`, connect fails immediately |
| cloudflare | `https://echo-studio.dawn-tunnel.dev` | **admitted** | **YES** — `HTTP 200` |

This machine sits on `172.22.96.0/20`; the Studio's LAN rope is on `192.168.87.0/24`. A
"return the first *admitted* rope" fallback selects the LAN rope and still fails. The fix
must therefore not assume the best *admissible* rope is reachable either — which is why 3.4 pairs
admission-aware selection with health feedback so a dead rope stops being selected.

### 1.4 Why the CGNAT gap is also a divergence defect

`src/core/PeerEndpointResolver.ts` already exports `hostOf`, `ipv4ToInt`,
`isTailscaleCgnat`, `isRfc1918`, `isForbiddenHost`, `isPublicHttps`, and
`docs/specs/mesh-endpoint-http-propagation.md` states the governing rule:

> "Both validate via the **SAME function** so the two can never diverge; ingest is the
> first line (no poisoning), resolve is the final line (no bypass)."

`peerUrlGuard` is a **third, hand-written copy** of host-range logic that never adopted
those predicates. The harm is not that CGNAT must be admitted — it is that the position was
**accidental, undocumented, and invisible** in a drifted copy.

### 1.5 Scope, honestly

These measurements prove the rejection symptom, the lossy adapter, and the
admitted-but-unreachable rope. They do **not** establish that this is the only cause of
every cross-machine failure — a dark peer, an immovable lease, or a surface with no
cross-machine read at all are separate problems, some tracked separately. This spec fixes
this defect; it is not the whole of cross-machine coherence.

## 2. The trap: two different trust questions

A naive "make both layers call the same function" would ship two regressions:

| Host | `peerUrlGuard` (may we send our token here?) | `PeerEndpointResolver` (is this a dialable peer rope?) |
|---|---|---|
| `localhost` / `127.0.0.1` / `::1` | **allowed** — it is us | **forbidden** (`isForbiddenHost`) |
| IPv4 link-local `169.254/16` | not matched -> refused | **forbidden** (incl. metadata) |
| IPv6 link-local `fe80::/10` | **allowed** | no predicate (IPv4-only) |
| IPv6 ULA `fc00::/7` | **allowed** | no predicate (IPv4-only) |
| CGNAT `100.64/10` | **refused** | **valid** for kind `tailscale` |

The 1.3(a) run proves the `localhost` / `::1` / ULA / link-local rows empirically. Importing
`isForbiddenHost` into the credential guard would refuse `localhost`, which it legitimately
permits.

**Design consequence.** The shared thing is the **predicate vocabulary**, not a single
verdict function. The guard composes shared predicates and keeps its own documented
loopback carve-out. Neither layer retains a private copy of range arithmetic.

## 3. Design

### 3.1 Stop discarding the candidate list

`resolveMeshPeerUrl` gains a list-returning sibling that preserves order **and** kind:

```ts
export interface PeerEndpointSelection {
  url: string;
  kind: 'tailscale' | 'lan' | 'cloudflare' | 'last-known-url';
}

export function resolveMeshPeerCandidates(
  resolver: PeerEndpointResolver | undefined,
  machineId: string,
  endpoints: MeshEndpoint[] | undefined,
  lastKnownUrl: string | undefined,
): PeerEndpointSelection[]
```

`last-known-url` is the explicit kind for a legacy `lastKnownUrl` with no matching endpoint
record, so "kind unknown" is a *representable value*, never an absent argument.

The existing single-URL `resolveMeshPeerUrl` is **retained** for callers that genuinely want
one rope (the identity mesh-send path already layers its own transport), so this change does
not disturb them.

### 3.2 Typed selection, required kind, at the guard

```ts
export function isPeerUrlAllowedForCredentials(
  selection: PeerEndpointSelection,
  extraHostSuffixes?: readonly string[],
): PeerUrlVerdict
```

`kind` is **required** — a forgotten kind is a compile error, not a silent wrong refusal.
All 20 call sites are updated in one pass; 9.1 records why the draft's optional parameter
was wrong.

### 3.3 Shared predicate vocabulary

`peerUrlGuard` imports `isTailscaleCgnat`, `isRfc1918`, `ipv4ToInt` from
`PeerEndpointResolver` and deletes its hand-rolled RFC-1918 regexes. The IPv6 ULA /
link-local / loopback checks and the `localhost` carve-out stay, each with a comment naming
why it diverges from the resolver (loopback is self, not a peer).

### 3.4 THE FIX — admission-aware SELECTION plus health feedback (one destination, as today)

**Round-12 simplification, and the last one.** Rounds 6-11 kept trying to make *multi-rope
failover* safe: a new sequential helper, then extracting the lease path's hedge, then a signed
challenge, then restricting failover to TLS ropes. The conformance gate rejected each on *Know
Your Principal* grounds, and the last rejection was correct at its root: **any** design that
sends the bearer token to more destinations than today has to justify the extra destinations,
and no mitigation short of follow-up (1) can. <!-- tracked: CMT-013 -->

**Why single-attempt, argued from the threat model rather than from review history
(round-18 correction).** Earlier text justified this by saying the gate kept rejecting
within-call failover. That is an appeal to a reviewer's persistence, not an argument, and the
reviewer was right to call it out: **per-call request count is an operational exposure budget,
not a principal-authentication boundary.** For *authentication* purposes the two designs are
identical — neither authenticates the destination, and both can contact additional
registry-listed hosts.

The real, and narrower, argument is a steady-state one:

- **Within-call failover** contacts up to N hosts **on every call that hits a failure** — the
  cost recurs for as long as the fault persists.
- **Across-call selection** contacts exactly **one** host per call, and because each outcome
  feeds the health map, a converged system settles on the single healthy rope and **stops
  contacting the others at all**.

So the long-run set of distinct hosts contacted is similar, but the **steady state** is one
host rather than N. That is a genuine exposure-budget improvement and it is the honest reason
for the choice. It is **not** a claim that within-call failover would be unsafe where this is
safe — under the same threat model both carry the same unauthenticated-destination residual,
accepted in 4.1.1. The cost of this choice is the slower convergence stated below.

**The whole fix, in two parts:**

**(a) Filter by admission at SELECTION time, not after.** Today `resolveMeshPeerUrl` takes
`resolve(...)[0]?.url` — the health-best rope — and the fan-out then discovers the guard
refuses it, with nowhere to go. Instead, filter the candidate list by
`isPeerUrlAllowedForCredentials` **first** and take the best *admissible* rope:

```ts
export function resolveMeshPeerSelection(
  resolver: PeerEndpointResolver | undefined,
  machineId: string,
  endpoints: MeshEndpoint[] | undefined,
  lastKnownUrl: string | undefined,
  extraHostSuffixes?: readonly string[],
): { ok: true;  selection: PeerEndpointSelection; refusals: RopeRefusal[] }
  | { ok: false; outcome: 'url-rejected' | 'no-known-url'; refusals: RopeRefusal[] }

interface RopeRefusal { url: string; kind: PeerEndpointSelection['kind']; reason: PeerUrlVerdict['reason'] }
```

A CGNAT rope no longer dead-ends the peer — it is simply not selected. **`refusals` is present
on BOTH branches** (round-13 finding), so a *successful* selection still reports that the CGNAT
rope was skipped and why; these propagate into the pool row's diagnostics rather than being
discarded on success. **Exactly one rope is chosen and exactly one request is made, as today.**

**(b) Feed the health map from pool traffic.** The fan-out calls
`resolver.recordResult(machineId, kind, ok, latencyMs, url)` after its single attempt.
Today pool traffic teaches the resolver nothing, which is why a dead rope stays selected
forever. With feedback, the existing machinery does the rest: at
`unhealthyAfterFailures` (default **3**) consecutive failures a rope is flagged dead and
deprioritized-but-probed, so selection moves on by itself.

**Why this is enough, and its honest cost.** On this fleet (1.3(b)) selection picks the LAN
rope first — admitted and unreachable from this machine. It fails, the failure is recorded,
and after the third consecutive failure the LAN rope is demoted and the cloudflare rope is
selected. So the read **converges within about three poll cycles rather than instantly**.
That is the price of the exposure-budget choice above. What it buys the user is the removal of
a permanent dead-end; what it does not buy is an instant fix.

**The claim, stated as narrowly as the mechanism supports (round 14).** Demotion requires
**three *consecutive* recorded transport failures with no intervening reset**. Two things can
prevent that from ever accumulating, and an earlier version of this section acknowledged them
and then still claimed "eventual recovery" — which does not follow:

- A **cache hit is not an attempt**, so coalesced polls do not advance the counter.
- The health map is **shared with lease traffic**, and a dead rope stays
  *deprioritized-but-probed*. A lease success or a due recovery probe on that rope resets
  `consecutiveFailures`. Repeated interleaving can therefore prevent demotion **indefinitely**.

So the honest guarantee is: **a rope that accumulates three consecutive recorded failures is
demoted and an admissible alternative is selected.** This spec does **not** claim eventual
recovery unconditionally, because the shared-reset interleaving is a genuine counterexample.
What it does claim without qualification is the part that fixes the reported defect: an
**inadmissible** rope (the CGNAT case in 1.1) is never selected at all, which removes the
permanent dead-end regardless of any health dynamics. The dead-but-admissible case (1.3(b)) is
improved probabilistically, not guaranteed, and follow-up (1) is what makes it deterministic by <!-- tracked: CMT-013 -->
allowing within-call failover. **No prediction is made about ordinary operating behavior.** An earlier draft said the user
would see working reads "shortly after the first polls." That is not established: the
integration fixture deliberately suppresses recovery probes, so it demonstrates the mechanism,
not the production timing — and §3.4b's reset interleaving can delay demotion indefinitely.
What is established: the **inadmissible-rope dead-end is gone from the first call**, which is
the reported defect. The dead-but-admissible case improves conditionally, and representative
shared lease/pool scheduling must be measured before any practical-recovery claim is made.
**If lease successes turn out to systematically mask pool failures, the remedy is a separate
pool-failure counter** — recorded as a known design option rather than assumed away.

**No change to `HttpLeaseTransport`.** The hedge-extraction of round 7 is **not needed** and is
dropped: this change touches no part of the lease path, which is the most safety-critical code
in the mesh. Extracting the shared hedge becomes relevant only with follow-up (1), where real <!-- tracked: CMT-013 -->
failover is safe.

#### 3.4.1 Transport failure vs request failure (round-6 finding, still load-bearing)

The health map is **shared with lease traffic**, so recording an application error as a dead
rope would demote a working lease path. The single attempt records:

| Outcome | `recordResult` |
|---|---|
| DNS/connect refused, host unreachable, TCP reset, TLS failure, our timeout | **`false`** — genuine transport failure |
| HTTP 2xx with a complete body | `true` |
| Any HTTP status (401/403/404/409/422/429/5xx) | **neutral — never `false`** — the rope carried the request; the *request* failed |

**The cross-subsystem property:** a peer answering 404 on every poll must leave the shared
rope-health map **unchanged**, so lease traffic is never demoted by an application error.

**Read path only.** The helper is `GET`/`HEAD`; it never carries a mutation, so there is no
question of a retried side effect.

**Redirects are NOT followed (round-17 finding).** "One selected URL" does not by itself bound
the number of token-bearing requests: a redirect — **same-origin included** — would produce
another. The helper sets `redirect: 'manual'` and treats a 3xx as a **terminal** response
(`request-failed`, with the status). The pre-existing note about `Authorization` being stripped
on cross-origin redirects is therefore **moot by construction** rather than relied upon, which
is the stronger position. Tested for both same-origin and cross-origin redirects.

#### 3.4.1a Outcome precedence — unambiguous, because the health map is shared

The round-16 review found the classification ambiguous for mixed cases: what is a **stalled
404**? A **caller cancellation**? A response that **exceeds our body-size limit**? Left
undefined, each could spuriously demote a rope that lease traffic depends on. Precedence is
evaluated **top-down; the first matching row wins**:

| # | Condition | `recordResult` | Rationale |
|---|---|---|---|
| 1 | **Caller cancelled** (the caller's signal aborted) | **neutral** | Our decision, not the rope's fault. Never demote on our own cancellation. |
| 2 | **Local policy rejection** — body exceeded our size limit | **neutral** | The rope delivered; *we* refused the payload. A local policy must never demote a peer. |
| 3 | **Transport failure before any status** — DNS, connect refused, host unreachable, reset, TLS, our timeout | **`false`** | The rope genuinely did not carry the request. |
| 4 | **Status received, then the body stalled or truncated** (incl. a stalled 404) | **`false`** | **Explicitly resolves the stalled-404 case:** a status line is not delivery. The rope failed to carry the response, which is a transport fact, so row 4 beats row 5. |
| 5 | **Complete response, any non-2xx status** | **neutral** | The rope carried a full answer; the *request* failed. |
| 6 | **Complete 2xx** | **`true`** | — |

The invariant this protects: **no HTTP status, and no local policy decision of ours, may ever
demote a rope that lease traffic shares.** Only a genuine failure to carry bytes does.

#### 3.4.2 Success requires a complete body within the deadline (round-6 finding)

A candidate can send headers then stall or truncate. Success requires reading the body to
completion (bounded by a max size) within the per-attempt deadline; a header-only response
that then stalls is a **transport failure**, not a success. The helper returns parsed bytes
rather than a live `Response`, so no caller can observe a half-read stream, and the caller's
`AbortSignal` propagates.

#### 3.4.3 Outcomes stay distinct

| Situation | `outcome` |
|---|---|
| Selected rope returned a complete 2xx | `ok: true` |
| Candidates existed, **all** guard-refused | `url-rejected` (with per-rope reasons) |
| Selected rope was admitted but the attempt failed at transport level | `peer-unreachable` (**new** named reason — today indistinguishable from a refusal) |
| Selected rope returned a terminal HTTP status | `request-failed` (+ `status`) |
| No candidates at all | `no-known-url` (pre-existing) |
| **Caller cancelled** | `cancelled` — propagated to the caller, **never** `peer-unreachable` |
| **Our body-size policy rejected the payload** | `local-policy-rejected` (+ `limit`) — our decision, **never** `peer-unreachable` |

The last two rows are the round-17 correction: 3.4.1a gave cancellation and oversized bodies a
*health* classification (neutral) but no **caller-visible outcome**, so they would have been
reported as `peer-unreachable` — misdiagnosing our own local decisions as the peer being
unreachable. Both the health record and the reported outcome must stay neutral about the peer.

`peer-unreachable` is the reason that makes 1.3(b) diagnosable: "we had an admissible rope and
could not reach it" has never been expressible before, which is part of why this defect was
invisible.

**One policy, both ends.** The operator suffix allowlist (`multiMachine.peerUrlAllowlist`) is
passed into selection as well as admission, so selection cannot choose a rope admission would
reject.

### 3.5 CGNAT admission is NOT built here — the refusal becomes deliberate and named

Earlier drafts admitted CGNAT plaintext, then admitted it behind a default-off flag. **Both
removed.** The benefit was only *directness* — a fast local hop — which 3.4 makes
unnecessary. The cost would have been a lever permitting **full agent API token** egress
(4.2) on a premise this spec documents as unverifiable. A default-off lever whose risk is
explained three sections away is a lever someone flips without reading.

Instead: the guard recognizes CGNAT via the shared `isTailscaleCgnat` predicate purely to
**name the refusal accurately** — `cgnat-plaintext-unsupported` instead of today's
misleading `scheme-not-allowed`, which reads as "we don't do plaintext" when the true
statement is "we do plaintext inside ranges we treat as the operator's own, and CGNAT is
deliberately not one of them." **The shared predicate is used for diagnosis, not to widen
trust.** The refusal is kind-independent: no kind admits CGNAT plaintext in this change.

Admission moves wholly to the sequenced follow-up (4.3). Rejected alternatives, recorded: <!-- tracked: CMT-013 -->
(a) admit CGNAT unconditionally for `http` — grants trust on a self-asserted address shape;
(b) admit behind a default-off flag — the round-4 position, rejected in round 5.

### 3.6 Non-goals

- No change to **who** may read a pool surface. This decides only which transport carries an
  already-authorized token.
- No new blocking authority (signal-vs-authority).
- No change to ingest validation, lease signing, or the rope-health monitor.
- No new config key.
- Not an IPv6-Tailscale change (`fd7a:115c:a1e0::/48` out of scope; this fleet advertises
  IPv4 ropes).

## 4. Security

### 4.1 Credential posture — admission rules unchanged, destinations contacted can increase

**Stated minimally, after round 14 caught the earlier framing contradicting its own risk
acceptance.** Two separate facts, neither softened:

**Unchanged:** the *rules* for which hosts may receive the token (3.5 admits nothing new), and
the number of token-bearing requests **per call** (one, as today).

**Increased:** the set of hosts actually contacted **across calls**. When the preferred rope is
inadmissible or repeatedly failing, selection moves to another rope from the peer's registry
entry — a host today's code might never have contacted. That is a real increase in exposure,
not an equivalent one, and earlier versions of this section wrongly claimed otherwise.

**Unchanged and NOT fixed here:** no destination is authenticated as the intended peer, before
or after. This change does not narrow that gap; 4.1.1 is the reasoned acceptance and 4.3 is the
remedy.

#### 4.1.1 The residual the gate keeps naming — accepted, with the argument scoped

*(This section was accidentally deleted during the round-14 rewrite of 4.1 and restored in
round 16 when the external reviewer noticed 4.1 citing a section that was no longer there. The
slip is left on the record because "the spec cites its own missing justification" is exactly
the failure a convergence loop exists to catch.)*

The Standards-Conformance Gate flagged *Know Your Principal* on **every** version of this
design across sixteen rounds, including the final one, with a correct observation: the bearer
token is released to destinations whose identity as the peer is not authenticated, and
health-driven reselection can contact registry-listed hosts this code would not have contacted
before.

**Accepted, and here is the whole argument with its limits:**

- **Where exposure is genuinely equivalent** — an attacker who **controls advertisements**.
  Ordering is by endpoint **kind** priority plus health (`priorityOf`,
  `PeerEndpointResolver.ts:133`), so such an attacker's best play is to advertise **only** a
  hostile RFC-1918 `lan` endpoint; it is admitted by today's guard, becomes rope[0], and
  **today's code sends it the token immediately**. They gain nothing from this change.
- **Where exposure genuinely increases** — two cases the equivalence argument does **not**
  cover: a **stale address** legitimately advertised and since reassigned (no attacker
  required), and an attacker holding only a **fallback** destination, which today is contacted
  only if selected first. Both are accepted on the strength of the small population (hosts
  already in the operator's own registry entry) and the sequenced remedy — **not** on an
  equivalence claim.
- **What would close it** — follow-up (1), whose requirements 4.3 now states precisely. <!-- tracked: CMT-013 -->

**What is being shipped:** a fix to a broken capability that slightly widens which hosts
actually receive the token, leaving the credential-authentication gap itself unaddressed. An
explicit accepted risk, not a clean bill of health.

### 4.2 Why CGNAT admission is not here — the exposure it WOULD have carried

Retained in full, because it justifies 3.5 and must inform 4.3.

- **No encryption claim.** An earlier draft argued "Tailscale carries WireGuard encryption,
  so `http` over a tailnet is not plaintext on the wire." **Withdrawn.** A signed
  advertisement establishes *who advertised an address*; ingest validation establishes *its
  range*. Neither establishes that this machine's current route traverses the tailnet
  interface, nor that it reaches the intended peer.
- **Provenance is not uniform, and the draft overstated it.** On the **broadcast** path
  endpoints travel inside the `signRequest`-hashed lease body — genuine Ed25519 provenance.
  On the **`/api/lease/pull` RESPONSE** path the parent spec states there is *no holder-match
  guard* and the puller-side binding is `response.machineId === expectedPeerId` — a
  **self-asserted body field**, with cryptographic accept-ack binding only *preferred where
  it already exists*.
- **Third-party impersonation is a real additional exposure, not a collapsed case.** An
  earlier draft claimed this "collapses into a paired peer lying about its own addresses."
  **False.** An impersonating responder can present the expected `machineId` **without
  compromising the paired machine**. The field match prevents injecting a *third machine's*
  identity; it does not authenticate the responder.
- **What is at stake.** Pool fan-outs send `ctx.config.authToken` (`routes.ts:9921`, `10531`,
  `10952`, `12068`, ...) — the **same single server Bearer token** `authMiddleware` accepts
  for *every* authed route, mutations included. There is no read-only scoping. An earlier
  draft called it "a peer-pool read credential"; false.
- **"We already do it for LAN" is not sufficient on its own.** Existing LAN plaintext
  exposure does not establish consent for an additional exposure. Offered as context, not
  justification.

### 4.3 Registered hardening (Close the Loop), sequenced

1. **Stop using the bearer token for peer traffic — authenticate the REQUEST instead.**
   `src/server/machineAuth.ts` already exports `signRequest`, producing a per-request Ed25519
   signature over `machineId|timestamp|nonce|sequence|bodyHash`, with replay protection and
   body binding, served by `machineAuthMiddleware`. The mesh routes use it today; the pool
   read routes do not. Moving pool fan-outs onto it would mean **no reusable credential
   crosses the wire**: an intercepted signed request yields no token to reuse against other
   routes. It does **NOT** authenticate the destination, supply response authentication, or
   provide confidentiality — see the requirements below. Registered under Close the Loop as the
   sequenced prerequisite, with its own spec.
2. **Then plaintext-rope failover and CGNAT admission** — admissible only once (1) delivers
   **destination authentication**, not merely request signing. Removing the bearer token alone
   does not make them safe, and this item must not be read as saying it does.

The ordering is the point: shipping (2) first, even dark, transfers risk to whoever enables
it. Registering it sequenced keeps the deferral honest rather than an IOU. <!-- tracked: CMT-013 -->

## 5. Tests (all three tiers — non-negotiable)

**Unit — guard:**
- CGNAT `http`, every kind -> refused `cgnat-plaintext-unsupported`. Allow/deny behavior
  identical to today; only the diagnostic reason changes, and it is now accurate.
- **No admission path exists:** a table-driven assertion that **no** combination of kind,
  suffix list or scheme admits a CGNAT host over `http`. This is the test that fails if a
  future change quietly reintroduces the lever 3.5 removed.
- `localhost`, `127.0.0.1`, `::1` still `ok` over `http` (guards the section-2 trap — proves
  the fix did not import `isForbiddenHost` blindly).
- IPv6 ULA `fc00::/7` and link-local `fe80::/10` still `ok`.
- Public `http` still refused; `https` tunnel-pattern and operator-suffix paths unchanged.

**Unit — admission-aware selection (3.4a), the regression test for 1.1:** candidates
`[CGNAT (refused), LAN (admitted), cloudflare (admitted)]` -> selection returns the **LAN**
rope (best admissible), with the CGNAT rope's named refusal reported. A `[CGNAT only]` peer ->
`url-rejected` with its reason. A peer with no endpoints -> `no-known-url`.

**Unit — exactly one destination (the security-critical assertion):** for any candidate list,
selection yields **at most one** rope and the fan-out issues **at most one** token-bearing
request per peer per call. This is the test that fails if anyone reintroduces multi-rope
failover without follow-up (1). <!-- tracked: CMT-013 -->

**Unit — health feedback behavior (3.4b), against the REAL resolver.** These tests certify
**demotion under stated conditions**, not eventual recovery — §3.4b disclaims the latter, and a
test must not certify more than the design claims. With
`unhealthyAfterFailures = 3`, a peer whose best admissible rope is unreachable. Asserted
against `PeerEndpointResolver` itself, not a mock, because the claim is about its ordering and
probe semantics:
- Convergence is expressed in **recorded attempts, not wall-clock polls** — a **cache hit is
  not an attempt**, so a coalesced poll does not advance the counter. The bound is "three
  recorded failures," and the test asserts cache hits do not count.
- **Interleaved lease traffic and recovery probes** are included, since the health map is
  shared: a lease success on the dead rope, or a due recovery probe, can reset
  `consecutiveFailures`. The test asserts what happens then — honestly, selection can revert
  to the dead rope. The test asserts that outcome rather than asserting recovery: with
  interleaved resets, demotion may **never** accumulate. The spec claims only
  **demotion after three consecutive recorded failures**, and the unconditional guarantee is
  the separate one — an inadmissible rope is never selected.
- **Probe-due re-selection** is asserted explicitly: a dead rope stays
  `deprioritized-but-probed`, so it will periodically be chosen again. By design, not a
  regression.
- **The counterexample is a TEST, not a caveat:** an interleaving where a lease success resets
  the counter before three consecutive pool failures accumulate is asserted to leave the dead
  rope selected. This test exists so the limit is *demonstrated* rather than merely admitted —
  nobody should later read "converges in three cycles" as a guarantee.
- **What IS certified unconditionally:** an **inadmissible** rope is never selected. That is the
  property that fixes 1.1, and it has no dependence on health dynamics at all.

**Unit — transport vs request outcome (3.4.1), the round-6 finding:**
- connect-refused / host-unreachable / TLS failure / timeout -> `recordResult(false)`.
- **Any** HTTP status (401/403/404/409/422/429/5xx) -> `recordResult` **neutral**, never
  `false`.
- **Cross-subsystem assertion:** a peer answering 404 on every poll leaves the shared
  rope-health map unchanged, so lease traffic is never demoted by an application error.

**Unit — deadlines cover the body (3.4.2):** headers-then-stall -> transport failure;
headers-then-truncate -> transport failure, not success; caller cancellation aborts the
attempt; the helper returns bytes, never a live `Response`.

**Unit — the five distinct outcomes (3.4.3):** success / `url-rejected` / `peer-unreachable` /
`request-failed` / `no-known-url` each produce their own named outcome. Explicitly asserts
`url-rejected` and `peer-unreachable` are **not** interchangeable.

**Unit — the lease path is untouched:** `HttpLeaseTransport`'s existing tests pass unchanged,
and a test asserts this change imports nothing from it and modifies no file under it.

**Unit — safe methods only (3.4.1):** the helper's type forbids a non-`GET`/`HEAD` method; a
runtime guard rejects one if constructed dynamically.

**Unit — deadlines cover the body (3.4.2):**
- A response that sends headers then **stalls** -> transport failure (recorded, so the rope is
  demoted toward the next selection), not a success.
- A candidate that sends headers then **truncates** -> transport failure, not a success.
- **Caller cancellation** aborts the in-flight attempt and is classified **neutral** (3.4.1a).

**Unit — the five distinct outcomes (3.4.3 table):** success / `url-rejected` /
`peer-unreachable` / `request-failed` / `no-known-url` each produce their own named outcome,
and diagnostics are present on **both** result branches (asserts a *successful* result still
reports which ropes the guard refused during selection).

**Unit — one policy both ends:** a rope admissible only under an operator suffix is ordered
AND admitted consistently.

**Unit — observer-relative endpoint sets:** two observers with *different* and with *stale*
endpoint sets for the same peer each resolve against their own view; neither is drift.

**Unit — forged-response fixture:** a pull response carrying the *correct* expected
`machineId` from an unauthenticated responder is recorded under today's rules — asserted so
the 4.2 impersonation exposure is a **tested, visible fact** rather than a paragraph, and so
4.3(1) has its failing-first regression.

**Anti-divergence — claim narrowed to the evidence:**

> Duplicated range arithmetic is harmful only when it **diverges**. A second implementation
> agreeing on every address causes no bug — the reported defect *is* a divergence. So
> detecting divergence detects the harm, without proving absence of duplication.

- **Primary — exhaustive boundary + interior + property equivalence.** For every range the
  shared predicates own (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `127/8`,
  `169.254/16`): agreement with `isRfc1918` / `isTailscaleCgnat` on **both addresses either
  side of every boundary**, plus **interior** addresses, plus a **property-based** sweep over
  random IPv4 space. Interior and property cases are required because an erroneous
  inclusion/exclusion *inside* an existing range needs no new range — an earlier draft
  asserted otherwise and that assertion is removed.
- **Secondary — lint, scope stated.** Literal-regex / dropped-import check: a cheap fast
  signal for the most likely textual form. **Not** the guarantee.
- **Residual, stated:** a reimplementation diverging only where nothing is enumerated would
  pass. Mitigated by the property sweep, not by a claim of completeness.
- **Not covered, by design:** a call site omitting a kind — a compile error now.

**Integration — mislabeled endpoint, split honestly.** A CGNAT address labeled `lan` is
discarded by per-kind validation at ingest **and again at resolve**, so it cannot reach
credential admission through any normal path. Three cases:
1. **Ingest rejection:** the receiver discards a CGNAT-labeled-`lan` advertisement before
   storage.
2. **Resolve filtering:** such an entry hand-written into a test registry is discarded by
   resolver validation; assert the **end-to-end** outcome — the next admissible rope is
   *selected*, or `no-known-url` when none remain.
3. **Guard directly (unit):** the CGNAT refusal asserted with a constructed selection — the
   right level, since integration can no longer deliver it.

**Integration — the reported defect, as a SEQUENCE of separate uncached calls (round-16
correction).** The single-attempt design cannot reach a third rope within one call, so the test
must not pretend otherwise. With the poll cache bypassed and recovery probes held off:
1. **Call 1-3:** the CGNAT rope is never selected (no `url-rejected` row for it); the
   admitted-but-unreachable LAN rope is selected and fails -> `peer-unreachable`, one recorded
   failure each.
2. **Call 4:** the LAN rope is now demoted (three consecutive failures) -> the cloudflare rope
   is selected -> `peersOk >= 1`.

Asserts exactly **one** token-bearing request per call, and that the permanent dead-end of 1.1
is gone from call 1 onward even though full success arrives at call 4.

**E2E (alive):** the guard and `resolveMeshPeerSelection` are constructed and wired in the boot
path; `kind` reaches **every** real fan-out callsite, and the fan-out's `recordResult` feedback
is wired to the real resolver (not a no-op).

**Live cross-machine (the real bar):** from the standby machine,
`GET /threadline/peers/health?scope=pool` returns `peersOk >= 1` with zero `url-rejected`
rows, achieved with **no new credential trust**. Surfaced as real command output, not prose.

## 6. Migration parity

The generated CLAUDE.md **is** an agent-installed file, so a `generateClaudeMd()` edit
without a matching migration is a feature that only works for newly-initialized agents —
every deployed agent, including the one that reported this defect, would keep the stale
briefing. An earlier draft claimed "no agent-installed files change" while editing exactly
that; the conformance gate caught the contradiction.

- **`generateClaudeMd()`** (`src/scaffold/templates.ts`) — new agents at `init`.
- **`migrateClaudeMd()`** (`src/core/PostUpdateMigrator.ts`) — content-sniffed, idempotent
  section so **existing** agents receive it on update.
- **No config key**, so `migrateConfig()` is untouched.

**Agent Awareness content:** a pool read that previously showed `url-rejected` now fails over
to the peer's other ropes; `cgnat-plaintext-unsupported` is the accurate refusal for a
tailnet rope; `peer-unreachable` is the **new** reason meaning "we had admissible ropes and
the rope we selected could not be reached," distinct from `url-rejected` ("we refused every
rope") and
`no-known-url` ("the peer advertised none").

## 7. Side effects and rollback

- **More pool reads succeed**, which is the intent; the existing poll cache and CPU load-shed
  still bound volume.
- **The attempt count per call is unchanged (one).** What changes is *which* rope that one
  attempt targets. There is no within-call retry, so no new per-call cost.
- **Rope-health map now receives pool-traffic outcomes.** Strictly more signal for an
  existing consumer; the rope-health monitor's own probing is unchanged.
- **Rollback:** one coherent commit, reverted **as a unit** — a partial revert leaves call
  sites passing a selection object to a guard that no longer accepts one, which is a compile
  failure rather than silent misbehavior (the safe direction).

## 8. Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| `isPeerUrlAllowedForCredentials(selection, suffixes)` — credential-transport admission | **invariant** | Deterministic by design and correctly so. Inputs are a URL, an operator-configured suffix list, and an endpoint kind; "is this host in range X / of kind Y" has one right answer with no competing signals. A non-deterministic answer would make credential egress unpredictable — the worst property for this gate. A wrong *range table* is a bug to fix, not a case for an arbiter. |
| Candidate **ordering** (`PeerEndpointResolver.resolve`) | **invariant (unchanged)** | Already a deterministic latency+liveness ordering owned by the resolver. This change consumes it; it does not alter the ranking rule. |
| Which candidate is **selected** (3.4) | **invariant** | "The highest-ordered candidate the guard admits" — deterministic given the resolver's ordering and the admission rules. One selection, one attempt; no weighing of competing signals. |
| *(coverage note)* no point here weighs competing signals | **invariant** | No decision in this change gates information flow on contested evidence, blocks an agent action on a heuristic, or chooses among competing signals — so no `judgment-candidate` arises and no floor or arbiter is required. |

## 9. Reasoning trail

Six rounds of review (one external family — codex — plus the constitutional gate) materially
changed this design seven times, including two factual errors of mine about the system and two
withdrawn security claims. The full trail is preserved in
`docs/specs/reports/peer-credential-guard-tailscale-coherence-trail.md` and summarized in the
convergence report.

It is kept **out of this document deliberately**: a spec that appends its own review history
grows its reviewable surface every round, so precision findings accumulate without end and the
convergence loop cannot terminate on the merits. The design is what should be reviewed here.

Headline corrections, for a reader who needs the gist: the optional `kind` parameter would have
left the bug live on 19 of 20 paths; the multi-machine posture was factually inverted; the
"Tailscale encrypts it" and "read-only token" claims were both false; CGNAT admission was removed
outright rather than shipped dark; "first admitted rope" was mistaken for "reachable rope" and
would have shipped a non-fix; and the final design adds no within-call failover at
all — it filters at selection and lets the existing health map move selection on, leaving the
lease path untouched.

## 10. Multi-machine posture

Default posture is `unified`.

| Surface | Posture | Notes |
|---|---|---|
| `isPeerUrlAllowedForCredentials` — the predicate | **unified** | Pure function over its arguments. Identical on every machine; no state. |
| Endpoint `kind` records | **machine-local BY DESIGN** | `machine-local-justification: hardware-bound-resource` — inherited, not redeclared: the parent spec states peer `endpoints` are machine-local, NOT replicated, NOT proxied-on-read, because reachability is observer-relative ("the laptop's route to the Mini is the laptop's fact"). |
| Candidate ordering + rope health (3.1, 3.4) | **machine-local BY DESIGN** | `machine-local-justification: hardware-bound-resource` — which ropes *this* machine can reach, and how fast, is a property of its own interfaces and network position. 1.3(b) is the direct evidence: the Studio's LAN rope is reachable from a same-LAN peer and dead from this one. A unified ordering would be wrong for every machine but one. |

**Consequence for testing:** two machines can hold **different or stale endpoint sets** and
**different health orderings** for the same peer, so a peer may be reached over different
ropes from different machines. Correct behavior, not drift; section 5 tests it.

Bidirectional check: both machine-local rows are genuinely infeasible as `unified` —
replicating one observer's reachability facts would actively break peers — so each carries a
closed-taxonomy key. The predicate row is correctly `unified`. **No per-machine credential
state** is introduced.

**No user-facing notice** is introduced, so one-voice gating does not apply. **No generated
URL.** **No new durable state**, so nothing strands on topic transfer. The rope-health map is
pre-existing and already machine-local.

## 11. Self-heal posture

Not applicable as a *new* watcher — this change introduces no monitor, no recurring notice
source, and raises no operator attention item. It modifies one pure predicate, adds a
list-returning resolver sibling and a shared fetch helper, and feeds the **existing** rope
health map.

Worth naming, though: 3.4's `recordResult()` feedback makes the system *more*
self-correcting than before — a dead rope now sinks in the ordering because of real pool
traffic, where previously pool traffic taught it nothing. That is existing machinery
receiving signal it should always have had, not a new escalation path.

## 12. Verify the State, Not Its Symbol (P20)

### 12.1 The admission/reachability pair (the round-5 lesson, now in the design)

| | |
|---|---|
| **Symbol** | The credential guard's `{ok:true}` verdict for a rope. |
| **State it does NOT prove** | That the rope is reachable. 1.3(b) measures a rope that is admitted and dead. |
| **How the design respects this** | 3.4 never treats admission as success. It **attempts** the connection, and only a complete response counts; a failure is **recorded into the health map**, which is what moves selection off a dead-but-admissible rope on subsequent calls. The distinct `peer-unreachable` outcome exists so "admitted" and "worked" are never conflated in the output either. |

### 12.2 The CGNAT kind symbol (follow-up only) <!-- tracked: CMT-013 -->

Applies to the sequenced follow-up (4.3), not to anything this change admits — nothing is <!-- tracked: CMT-013 -->
admitted on the `kind` symbol here. The guard reads `kind` only to **name** a refusal;
reading a symbol to produce an accurate message carries none of the risk of reading it to
grant a permission.

| | |
|---|---|
| **Symbol read** | The endpoint's `kind` (`'tailscale'`) and the URL's host in `100.64.0.0/10`. |
| **State a future admission would claim** | "This address reaches the paired machine we intend, over a path we trust." |
| **Corroboration available today** | Non-uniform: Ed25519-signed body on the broadcast path; a `machineId` **field match** on the pull-response path (4.2). |
| **Symbol present, state absent?** | Four ways, three needing no attacker: compromised paired machine; **stale** advertisement; **local routing change**; **unauthenticated impersonating responder**. The redirect mitigation does **not** apply — `Authorization` is stripped on cross-origin *redirects*, but the token already reached the **initial** destination, which is the exposure. |
| **State present, symbol absent/stale?** | A genuine tailnet peer with a missing or pre-upgrade endpoint record presents no `tailscale` kind -> refused, and 3.4 fails over. Never a silently dropped peer. |
| **Unmeasurable case** | Any CGNAT host -> explicit `cgnat-plaintext-unsupported`. In this change that is the **only** case; there is no admitting branch. |
| **What is at stake** | The **full agent API token** (4.2), not a scoped read credential. Why 3.5 removed admission outright and why 4.3 authenticates the destination rather than the record. |

## Frontloaded Decisions

1. **Share the predicate vocabulary, not a single verdict function** (2, 3.3) — a merged
   verdict would regress `localhost` and IPv6 trust, shown empirically.
2. **`kind` is a REQUIRED field on a typed selection**, all 20 call sites in one pass (3.2);
   see 9.1.
3. **Stop discarding the resolver's candidate list** (3.1) — a list-returning sibling,
   leaving the single-URL helper for callers that want it.
4. **The fix is admission-aware SELECTION plus health feedback — one destination, as today**
   (3.4). No **within-call** multi-rope failover. Destination exposure **does** increase across
   calls (4.1) and the Know Your Principal residual **remains open and accepted** (4.1.1) — this
   decision does not dispose of it. Unconditional guarantee: an inadmissible rope is never
   selected. Conditional: demotion of a dead-but-admissible rope after three consecutive
   recorded failures, which interleaved resets can delay indefinitely.
4b. **The lease path is not touched** — the round-7 hedge extraction is dropped as unnecessary.
   Extracting it becomes relevant only with follow-up (1). <!-- tracked: CMT-013 -->
4c. **Transport health is recorded only on transport failure** (3.4.1) — the health map is
   shared with lease traffic, so no HTTP status may demote a working lease rope.
4d. **Success requires a complete body within the deadline; the helper returns bytes, not a
   live `Response`; read path only** (3.4.2).
4e. **Five distinct outcomes, including the new `peer-unreachable`** (3.4.3) — "we refused every
   rope" and "we could not reach the one we chose" are different operator-facing facts.
4f. **No multi-destination design without follow-up (1)** — rounds 6-11 produced four of them <!-- tracked: CMT-013 -->
   and the gate rejected every one on credential-exposure grounds. Moving peer traffic off the
   shared bearer token is the prerequisite, and it has its own spec.
5. **Four distinct outcomes, including the new `peer-unreachable`** (3.4) — "we refused every
   rope," "the rope we selected was unreachable," and "no ropes advertised" are different
   operator-facing
   facts.
6. **One shared fetch helper**, reused by all fan-outs inside their existing cache wrapper
   (3.4) — not 20 hand-rolled copies.
7. **CGNAT plaintext admission is NOT built** (3.5) — not default-off, absent; the refusal
   becomes deliberate and accurately named.
8. **4.3 must authenticate the DESTINATION, not merely sign the request** — signing proves the
   sender and removes reusable-credential exposure, but does not bind recipient, method or
   target, so it is not destination authentication (corrected in round 13). Sequenced before
   any plaintext failover or CGNAT admission.
9. **Keep `localhost`/`::1` allowed** in the credential guard, with a comment naming why it
   diverges from `isForbiddenHost` (3.3). Not a bug to "fix."
10. **Anti-divergence claims only divergence detection**, never absence of duplication
    (section 5).
11. **IPv6 tailnet addresses are out of scope** (3.6).

## Maturation plan

This is a **defect fix with no feature flag**, so the honest plan is short and the dark-window
is deliberately zero rather than unstated. A flag here would be worse: it would mean shipping
a known-broken selection path and asking someone to remember to turn the fix on.

- **test-agent-live:** the `test-as-self` deploy into a throwaway agent home, asserting the
  server boots, `GET /threadline/peers/health` answers 200, and a single-machine agent is a
  strict no-op (no peers ⇒ identical behavior to today).
- **dev-agent-live:** this agent (Echo) on the Windows machine and the Studio — the pair that
  produced the reported defect. Verified by the live bar in section 5: `?scope=pool` returns
  `peersOk >= 1` with zero `url-rejected` rows, surfaced as real command output.
- **fleet:** ships with the next release, no flag, no staged cohort. Justification: the change
  cannot be less correct than today's behavior for any agent — a single-machine agent has no
  peers and is unaffected, and a multi-machine agent currently dead-ends. The blast radius is
  bounded by the compiler (a required field) and by the lease path being untouched.
- **graduation criterion:** the dev-agent live verification above passing on a real machine
  pair, plus the full suite green. There is no soak period to graduate *from*, because there is
  no dark state to leave.
- **dark-window:** **none.** Stated explicitly rather than omitted. The one thing that *is*
  deferred — plaintext-rope failover and CGNAT admission — is not dark-shipped either: it is
  **not built**, and gated behind the destination-authentication follow-up (4.3). <!-- tracked: CMT-013 -->

## Resolved questions (kept out of Open questions, which must read *(none)*)

Every question raised across the 18 review rounds is resolved into a Frontloaded Decision
above, with the reasoning preserved in the trail report: optional-vs-required (9.1), the
admission default (9.4-9.6), admission-vs-reachability (9.7), and the sufficiency of the
follow-up gate (9.8). <!-- tracked: CMT-013 -->

## Open questions

*(none)*

---

## Addendum — 2026-10-22, after the first merge: what shipped, and one claim this spec got wrong

The first merge (#2286) shipped arm (a) of §3.4 — admission-aware selection — and
**not** arm (b), the health feedback. §3.4(b) says "Feed the health map from pool
traffic. The fan-out calls …", written in the present tense as though it were part
of the same change. It was not: the merged diff contained no `recordResult` call,
and every pool fan-out still dialled with a bare `fetch`. The tests all passed
because they test the *choosing* and never the *learning*.

Arm (b) is now built separately: `src/server/poolPeerFetch.ts` is the one place a
pool read dials a peer, and it reports each outcome into the SAME
`PeerEndpointResolver` the lease transport and the recovery prober already feed.
A Response — including a 500 — records a rope success, because the rope carried
the traffic and only the application disagreed; a thrown error records a failure.
A `last-known-url` records nothing, having no rope identity to attribute.

### The correction that matters more than the gap

While verifying arm (b) I measured the merged code against the live registry and
concluded the symptom was NOT fixed: selection appeared to choose the Mac Studio's
LAN rope, which answers `HTTP 000` from the WSL machine. **That measurement was
wrong, and the error was mine, not the code's.** I constructed the resolver by hand
with `config: {}`, which left two production settings unset:

- `lanSubnetGate: true` — with no `ownCidrs`, a peer LAN address on a subnet we do
  not share is dropped as a candidate entirely.
- `unhealthyAfterFailures: 3` — undefined makes `consecutiveFailures >= undefined`
  always false, so **no rope can ever be marked dead.**

Re-run with the exact production config and real `ownCidrs`, the shipped code picks
`cloudflare` for all three machines — the rope measured alive — and names
`tailscale=cgnat-plaintext-unsupported` among its refusals. So §3.4(a) alone does
fix the reported symptom from a different-subnet reader, and it fixes it *because*
the subnet gate removes the dead LAN rope before selection ever sees it.

This is the "a harness bug looks like a product bug" failure in its purest form: a
rig missing the real configuration produced a confident, wrong verdict about
shipped code, and that verdict was reported to the operator before being checked.

### What arm (b) is actually for, stated honestly

Not the reported symptom — that is already fixed. Arm (b) covers the case the
subnet gate cannot: a rope that is admissible *and* subnet-eligible and then dies.
Two machines on one desk share a subnet, so their LAN ropes are real candidates;
without feedback a LAN rope that goes down is selected forever. The convergence
test uses exactly that topology (reader placed on `192.168.87.30/24`) rather than
the live one, because the live topology would have passed against the broken code.

Tests: `tests/unit/pool-rope-health-feedback.test.ts` — the two topologies kept
distinct, convergence, recovery (the demotion is not a one-way door), the
Response-vs-throw recording contract, and wiring integrity including a structural
guard that fails if a future fan-out site dials with a bare `fetch`.
