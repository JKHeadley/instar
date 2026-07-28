---
title: "ACT-903 Standing Computer-Use Capability"
slug: "standing-computer-use"
author: "Instar-codey"
eli16-overview: "standing-computer-use.eli16.md"
status: draft
approved: false
ships-staged: true
parent-principle: "Never a False Blocker"
lessons-engaged: "P1,P2,P4,P5,P7,P9,P10,P18,P19,P20,P21,L3,L5,L6,L9,L11,L15,B14,B20,B22,B24,B28,B30,B39"
review-convergence: "2026-07-23T06:22:23.098Z"
review-iterations: 10
review-completed-at: "2026-07-23T06:22:23.098Z"
review-report: "docs/specs/reports/standing-computer-use-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex and gemini timed out in every changed-body round"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# ACT-903 Standing Computer-Use Capability

## Problem statement

Instar treats reading a screen and operating a browser as part of an agent's own
means, but today that ability is incidental to a session/provider and an available
logged-in Playwright seat. There is no durable contract saying which agent may use
which physical seat, for what bounded task, under which identity, or how a remote
machine may request the work.

ACT-903 defines a revocable standing capability to perform bounded browser
observation without re-granting access for every read. Capability is not effect
authority: the grant does not authorize clicking, typing, sending, buying, deleting,
accepting, or acting as a person. Existing coherence, external-operation, identity,
secret, and human-reserved-action floors remain in force.

This PR is **design only**. It changes no runtime, defaults, provisioning, Mini
behavior, or ACT-896.

## Goals and non-goals

Goals: make computer use discoverable and inspectable; extend the existing
Playwright profile/seat/MCP/gate infrastructure; serialize all compliant callers;
bind identity and privacy authority to an operator-signed grant; keep credentials and
raw screen data out of replicated/durable state; provide revocation, audit, rollback,
multi-machine routing, and dark/dry-run maturation.

Non-goals: general remote desktop, VNC/RDP, OS login bootstrap, cookie/keychain
replication, CAPTCHA, payment/legal/biometric authority, password/OTP entry, parallel
browser or ACL infrastructure, runtime implementation, Mini provisioning, ACT-896.

V1 is deliberately **Playwright browser observation only**. Desktop-wide input and
all browser input/effects require a separately converged specification and operator
approval.

## Capability and authority contract

The sole authorization substrate is an existing signed `CoordinationMandate` with
authority action `standing-computer-use`. `MandateStore` owns canonical bytes,
PIN-gated authorship, expiry and revocation; `MandateGate` is the point-of-use
verifier. No browser ACL and no second `AuthorizationPolicyManager` grant source are
introduced.

```ts
interface ComputerUseAuthorityBoundsV1 {
  version: 1;
  seatHost: { agentFingerprint: string; machineId: string };
  seatClass: 'playwright-browser';
  task: {
    purposeId: 'inspect-status' | 'inspect-page';
    topicId: number;
    initialUrl: string; // no query, fragment, userinfo, or embedded credentials
    allowedOrigin: { scheme: 'https'; asciiHost: string; effectivePort: number };
  };
  profile: {
    profileId: string;
    actingPrincipal: { type: 'agent' | 'operator'; id: string };
    verifierId: 'github-header-account-v1' | 'google-account-chip-v1';
    verifierEndpoint: {
      origin: { scheme: 'https'; asciiHost: string; effectivePort: number };
      path: string;
      method: 'GET';
    };
  };
  modelProcessing: {
    providerId: string;
    region: string;
    maxProviderRetentionDays: number; // integer 0..30
    trainingUse: false;
  };
  ceiling: 'observe-only';
  authLeaseTtlMs: 5000;
}
```

One mandate binds the requester fingerprint and one already-selected seat-host
fingerprint/machine. Availability may inform the choice before issuance, but may not
substitute another host afterward. A local drive may name the same fingerprint twice.
The operator approval card displays every bound field, including the auxiliary
identity-verifier endpoint, provider/region/retention, and a warning for
operator-profile privacy.

The dashboard Mandates tab is the only issue/revoke surface. It defaults to 1 hour
and permits 15m/1h/4h/24h, never longer. Renewal is a new mandate; narrowing is
revoke-and-reissue; agents cannot issue, edit, re-sign, renew, or widen. The mandate
id plus canonical authored-byte digest is the anti-rollback identity—there is no
invented browser grant epoch.

`initialUrl` is parsed and canonicalized once: exact HTTPS scheme, IDNA2008/punycode
ASCII host, explicit effective port, no userinfo, query, or fragment, bounded path, no
wildcards, trailing-dot aliases, public-suffix ambiguity, `data:`, `blob:`, `about:`,
token/code/key/signature/password values, or mixed numeric IP encodings. This prevents
signed URLs, magic links, OAuth codes, and high-entropy values from ever entering
canonical mandate bytes or the dashboard. Hermetic loopback is test-only. Equality is exact
scheme+ASCII host+effective port, not eTLD+1. Redirect, popup, download, service-worker
escape, origin change, and DNS rebinding fail closed.

### Stages

1. `eligible`: valid signed mandate, exact parties/host/task/profile/provider, current
   principals, compatible host capability.
2. `leased`: continuous exclusive host-wide seat plus fence.
3. `observation-authorized`: exact initial-load/observation passed coherence,
   GUI-semantic, provider-privacy, and external-operation floors.

The initial load is an explicit setup primitive, not a bypass:
`ComputerUseBroker.newPage(initialUrl)`. It runs inside the drive-owned isolated
page under the same lease, mandate, exact-origin and external-operation evaluation.
It is a `judgment-candidate` because even GET can log out, unsubscribe, track, or
mutate a session. The deterministic floor permits one top-level GET only; JavaScript,
subresources, credentials in URLs, service workers, WebSockets, SSE, keepalive,
downloads, popups, redirects, non-2xx status, and any later navigation are blocked.
`ExternalOperationGate` may allow, require approval, or block the exact GET; unknown
or degraded blocks.

### Deterministic admission floor

Reject missing/expired/revoked/authorship-invalid/future/wrong-party/wrong-host or
digest-mismatched mandates; unknown principals; any unbound task/origin/profile/
provider; empty or wildcard fields; unknown verifier/purpose; non-browser seat;
non-observe ceiling; every input/effect primitive; stale delivered mandate; expired
online authorization lease; incompatible protocol/config; lease conflict; unknown
privacy classification; pre-existing/cross-origin tab; stale resume.

`PlaywrightProfileRegistry.owner` and login assertions are advisory only. Acting
principal comes from the signed mandate. The seat host corroborates active MCP
user-data-dir, profile id, exact origin, and the selected closed service verifier
before every observation. Unsupported service or disagreement blocks. Hand-editing
the registry cannot change authority.

Verifier contracts are closed and corroborated:

- `github-header-account-v1`: signal A is the operator-signed mandate profile/principal
  plus active MCP user-data-dir equality; signal B is a fresh TLS/same-origin response
  from GitHub's authenticated account settings endpoint whose server-produced account
  identifier exactly matches the mandate. Arbitrary page DOM/header text is ignored.
- `google-account-chip-v1`: signal A is the same signed profile/config binding; signal
  B is a fresh TLS response from Google's authenticated `myaccount` identity endpoint
  whose server-produced stable account identifier matches the mandate. Arbitrary
  document/account-chip text is ignored.

Both signals must be from the current drive/lease, ≤5s old, exact-origin, no redirect,
and agree. Missing endpoint support, parsing ambiguity, spoofed DOM, stale cache,
service error, or disagreement blocks. Positive/negative fixtures include same-origin
lookalike content, cached identity, account switch, and hand-edited registry labels.

`PrincipalVerifierRegistry` is a signed-release, machine-unified closed registry. Each
`verifierId` row fixes exact HTTPS origin/path/method, DNS policy, cookie behavior,
redirect/subresource policy (`deny`), response content-type/schema and 16-KiB cap,
privacy class, parser version and evidence hash. The signed mandate's visible
`verifierEndpoint` must equal the row exactly. The broker's distinct
`identity-verify` primitive is the sole auxiliary network request: it runs under the
same mandate, auth lease, fence, pinned-public-DNS floor, EOG/privacy evaluation and
5s deadline; response bodies are parsed in memory and never logged or returned. The
“one top-level GET” limit applies to the observed page only. All network other than
that page GET and this one registry-enumerated verifier GET is denied. Revoke between
verify and observe invalidates the evidence.

## Observation, model, and credential boundary

V1 never enters credentials. Page content can produce only `credential-required`;
trusted orchestration may separately stage a server-authored Secret Drop request for
a preapproved service/origin. Page text never chooses a vault ref, label, or
recipient. Clipboard, password, OTP, passkey, upload/download, file chooser,
camera/mic/location/notification/USB/Bluetooth/screen-sharing permissions are denied.

The page is an immutable drive-owned `Page` inside the selected persistent profile
context, so it inherits the profile's live cookies without serializing/copying
`storageState`. It is not an incognito `BrowserContext`. The broker never enumerates,
adopts, focuses, captures, closes, or mutates pre-existing pages. Page ownership is
minted at creation and retained in the drive registry.

The only provider-facing primitives are the exact closed registry entries
`browser_snapshot` and `browser_take_screenshot`; exact provider tool aliases are
enumerated in the entrypoint inventory. Unknown tools/versions deny. `browser_snapshot`
is capped at 16 KiB. Screenshot is one crop, maximum 1024×1024 and 1 MiB after
deterministic pre-model masking. Full-frame capture does not exist in v1.

Pre-existing tabs, browser chrome, cross-origin frames, new tabs,
OAuth/password-manager/payment/OTP pages, secret/form fields, session QR/recovery
codes, cards and detected PII are excluded/masked before any model/provider call.
Redaction uncertainty falls to DOM-only or hold.

`ProviderPrivacyRegistry` is a blocking, machine-unified foundation artifact shipped
in the signed Instar release—not agent-authored config. Each row carries provider id,
region, retention/training claims, primary policy URL, captured policy-content hash,
reviewedAt, expiresAt (maximum 30 days), reviewer release commit and schema version.
The build/release process refreshes rows from provider primary documentation and a
second independent reviewer signs the update; runtime cannot self-assert a row.
Coherence-manifest hash equality is required across machines. Stale, missing,
signature/hash/version-mismatched, or provider-runtime disagreement blocks.
Eligibility requires exact equality with the mandate's provider id, region, retention
ceiling and `trainingUse:false`. The router may not fallback, retry, or swap to a
different/weaker posture.
Only capped/masked payloads reach the provider; raw capture never enters provider
request logs/traces. Transport-capture tests use canaries to prove this.

Raw observations are memory-only on the seat host. No raw pixels/DOM/text, cookies,
headers, credentials, URLs or page-derived free text enter durable audit, telemetry,
attention, MeshRpc, journals, or requester results. There is no debug-capture mode.

## Seat contention and foundation hardening

`PlaywrightSeatLease` and `/playwright-profiles/seat/{acquire,release}` remain the
single host-wide control plane but must be hardened before authority. The server
broker mints a 256-bit holder capability and durable monotonic fence; tool dispatch,
renewal and release require both. The drive owns one continuous lease from
profile-transition through terminal release. Waiting/approval releases it and
invalidates the observation plan.

Lease TTL and online auth lease are 5s, renewed at most once/second only for an active
drive. Each initial-load/observation has a 5s hard deadline. Old fences cannot dispatch
or release. Profile activation runs as `profile-transition` under the same fence
across config rewrite, refresh, and post-refresh corroboration; no identity switch can
occur beneath another holder.

There is no agent preemption. A compliant caller returns generic `automated seat in
use`; the dashboard operator-seat toggle returns `operator seat in use`. Arbitrary
manual use of an unrelated browser is not detectable and no stronger claim is made.
PIN-confirmed operator force-release increments fence and audits; agents cannot call
it. Same-OS-user arbitrary-code compromise is outside the cooperative-session threat
boundary, but direct-file tamper still fails closed.

Seat waiting is bounded: 32 in-memory waiters; no durable queue; server `retryAfter`
+20% jitter; exponential backoff capped 30s; max 20 attempts/5m; dedupe by
machine/profile/mandate; 5m breaker. Sustained-busy tests prove constant attempts.

### Blocking foundation gate

Phase 0 produces `docs/architecture/computer-use-entrypoint-inventory.md` and a CI
ratchet mapping every Codex/Claude/Gemini/standalone/helper/generated+installed-hook
path to seat admission, GUI-semantic classification, external-operation evaluation,
and real positive-control evidence. Unregistered entrypoints fail CI.

No observe-only canary may start until fault injection repairs/proves standing-drive
fail-closed behavior for current hook/server timeout/503/missing-session paths,
caller-chosen holder IDs, label leakage, corrupt/partial/symlink/wrong-mode/unreadable/
ENOSPC lease state, missing fence, fixed-TTL overlap, stale-lock mtime unlink, process
exit, lock-owner pause, ABA, active-config/profile disagreement, and SafeFsExecutor
jailing/atomicity. A robust lock uses owner nonce+liveness, never mtime alone. Legacy
one-shot compatibility may retain existing fail-open behavior only outside ACT-903.

## Drive lifecycle and page ownership

`requested → admitted → seat-waiting → profile-transition → profile-verified →
initial-load → observing → verifying → complete`

Held/terminal: `blocked-authority`, `blocked-privacy`, `blocked-human-reserved`,
`seat-busy`, `revoked`, `evidence-degraded`, `failed`, `cancelled`.

The seat-host server owns the lifecycle; providers/hooks are adapters. CAS key:
`(driveId, mandateDigest, leaseFence, transitionVersion)`. A drive-created isolated
page in the persistent profile context records immutable page ids. Restart never adopts a pre-existing page or
replays an operation: prior pages are left intact, lease expires, and the drive ends
degraded. Stop closes only proven drive-owned pages; uncertain pages remain intact.

The broker resolves the initial host, walks the CNAME chain, pins the public
destination set for the drive, and rechecks every connection. It rejects loopback,
RFC1918, link-local, multicast, reserved, IPv4-mapped IPv6, cloud-metadata and
localhost-alias destinations except hermetic fixtures. Because v1 blocks all
subresources/JS/workers/sockets, only the top-level pinned connection is admitted.
Private origins require a future visibly broader scope.

Initial-load completion requires network quiescence. On revoke/auth expiry/stop or
deadline, the broker aborts the request, disables further network, closes the proven
drive page, then releases the lease, all within the five-second cancellation bound.
Workers, streams, sockets, keepalive and downloads are proactively denied and tested.

## Multi-machine topology

Current Playwright profiles are machine-local and ACT-926 is unbuilt. ACT-903 adds a
scrubbed `computer-use-availability-v1` journal kind with full
`ReplicatedKindRegistry`/`JOURNAL_KINDS`/send/receive/union wiring. Key:
`(machineId,profileId)`; fields: machine id, profile id, signed acting-principal
digest, login-age class, seat-health class, capability version, observed/expiry,
signature. MachineAuth/current-boot required; last-writer only for the same signed
key. Caps: 4 KiB row, 25 profiles/machine, 10 machines/agent, 256-row response, 30s
freshness, 10m tombstone, one publish/key/10s, per-machine token bucket.

Drive status is a separate `computer-use-drive-status-v1` kind with identical registry
wiring. Key `(machineId,driveId)`; rows bind mandate digest, fence and monotonic
lifecycle rank; regressions/conflicting same-version rows reject. Caps: 4 KiB, 32
active drives/machine, one update/drive/2s, independent token bucket, terminal
tombstone 10m. Untrusted fields are closed enums/counts/digests. Cached union reads do
no live peer fanout. Local event audit does not replicate.

The advisory router selects availability before mandate issuance. After issuance the
exact host is frozen. `ComputerUseRouteArbiter` cannot substitute it; it only validates
the chosen host remains eligible. Fallback is hold.

Remote mandate transport requires a generalized
`PortableCoordinationMandateV1`/`DeliveredMandateStoreV2`, not the existing
account-follow-me-specific envelope. It wraps canonical mandate bytes, issuer
MachineAuth fingerprint, exact recipient agent+machine, purpose `standing-computer-use`,
nonce, issued/expiry and signature. Receiver reverifies HMAC authorship through the
issuer proof service, MachineAuth signature, recipient, purpose, expiry and replay
key before capped storage; old account-follow-me envelopes remain byte-compatible.

The mandate-issuing machine is the authoritative lease issuer. MeshRpc
`computer-use-auth-lease-v1` carries mandate id/digest, recipient, drive id, nonce,
request time and current fence. The issuer reads live `MandateStore`, checks revoke,
signs `{...request,notBefore,notAfter<=5s,issuerBootId,keyId}` with MachineAuth, and
never delegates renewal to the delivered copy. Nonce cache, skew ≤1s, current
boot/key, recipient and signature prevent replay. The dashboard proxies revoke to the
issuer; issuer offline means no renewal. Key rotation/restart invalidates old leases.

MeshRpc `computer-use-drive-v1` delivers the structured task to a **seat-host-local
controller** with exact recipient, mandate digest, idempotency key, deadline and
cancel token. Duplicate returns current scrubbed status; mixed protocol/config peers
deny. The requester receives only closed enums, server-authored labels from signed
task metadata, timestamps and keyed digests—never page/model text. The envelope is
marked untrusted observation and cannot authorize a follow-on action.

Machine-local surfaces:

- `surface: browser-profile-cookies-and-login`
  `machine-local-justification: physical-credential-locality`
- `surface: physical-playwright-seat-and-lease-fence`
  `machine-local-justification: hardware-bound-resource`
- `surface: live-screen-capture-primitive-and-memory-only-observations`
  `machine-local-justification: hardware-bound-resource`

## Audit, revocation, rollback

Local append-only events record event/drive/session/agent/machine, mandate id/digest/
revocation evidence, profile id and signed principal class, purpose/topic digest,
seat/fence/lifecycle, safe origin category + keyed domain digest, tool/action class,
decision/approval ids, observation/result keyed digests, redaction and error class.
Never pixels, DOM/text, values, cookies/headers, secret names, clipboard, downloads,
paths, URLs, or page-derived labels. The machine audit HMAC key rotates; events form a
prev-hash chain, rotate at 32 MiB×4 and retain ≤30 days. Audit corruption/deletion
failure blocks new drives as `audit-degraded`.

Revocation stops renewal of the 5s online auth lease. One already-started observation
has a 5s deadline, so the honest partition worst case is 10s. Clock/issuer uncertainty
prevents renewal; receipt never extends expiry.

Rollback: stop pool-wide admission → stop auth renewal → request drains and await up
to 10s → fence/expire residual holders → disable standing actuation → retain read-only
audit/status. Profiles, cookies and legacy one-shot Playwright remain intact.

## Decision points touched

| Decision | Classification | Floor / arbiter |
|---|---|---|
| Mandate issue/revoke | `invariant` | Existing PIN-gated signed mandate surface; requester never authorizes itself. |
| Grant/host/task/profile/provider validity | `invariant` | Closed canonical bounds and current principals; mismatch/unknown deny. |
| Initial-load external effect | `judgment-candidate` | One top-level GET under network/request floor; `ExternalOperationGate` judges open-domain GET risk; fallback approval/block, degraded blocks. |
| GUI tool classification | `invariant` | Closed `browser_snapshot`/`browser_take_screenshot` registry; unknown deny. |
| Live profile principal | `invariant` | Closed verifier registry; unsupported/disagreement deny. |
| Principal-verifier request | `judgment-candidate` | Exact signed registry endpoint/method/schema/cap/DNS/redirect floor; `ExternalOperationGate` judges authenticated-GET effect/privacy risk; fallback approval/block, degraded blocks. |
| Provider privacy | `invariant` | Verified provider registry must equal signed bounds; fallback forbidden. |
| Observation privacy | `judgment-candidate` | Hard origin/page/data/redaction caps plus `ExternalOperationGate`; unknown blocks. |
| Observation plan drift | `judgment-candidate` | Origin/tab/frame/dialog hard floor; `ObservationPlanArbiter`; fallback invalidate once then hold. |
| Minimization | `judgment-candidate` | `ObservationMinimizer`; DOM→masked crop→hold; never full frame. |
| Seat takeover | `invariant` | PIN-only route increments fence; agents denied. |
| Remote health/revocation/resume | `invariant` | Fresh signed projection/auth lease/fence/boot/version; unknown deny. |
| Completion | `invariant` | Closed structured observation result; crash ends degraded, no replay. |
| Expansion/graduation | `invariant` | Metrics graduate observation only; input/effects require another converged spec. |

## Arbiter evidence

Judgment provenance records arbiter/model/version, bounded input digests, floor result,
candidate set, choice, fallback, decision id, outcome label and privacy incidents—no
raw page data. Before canary, each arbiter shadows at least 200 representative cases:
zero privacy/floor violations (upper 95% one-sided binomial bound <1.5%);
`ObservationMinimizer` must preserve task-sufficient information in ≥95% versus
DOM-only; `ObservationPlanArbiter` must reduce unnecessary holds ≥20% versus
always-invalidate without increasing privacy incidents. Fail/degraded uses the
deterministic default. Graded cases feed the existing bench battery.

## Frontloaded Decisions

1. V1 is Playwright observation only; no desktop/input/effects.
2. Signed Coordination Mandate is the sole grant; one exact requester/host pair.
3. Closed structured purpose/topic/URL/origin/profile/principal/provider bounds.
4. Mandates default 1h/max 24h; auth+seat leases 5s; operation deadline 5s; revoke
   worst case 10s.
5. Profile registry owner is advisory; signed principal + closed live verifier rules.
6. Initial load is one broker-owned, gated exact-URL GET in a drive context.
7. One continuous exclusive fenced seat; no agent preemption; operator force-release
   is PIN-only.
8. Raw observations are memory-only; no full-frame/debug persistence.
9. Seat-host-local controller; provider privacy is signed and verified; no weaker
   fallback.
10. Two bounded replicated projection kinds; no raw data replication.
11. Unknown/crash never replays or adopts old pages.
12. This PR is design-only and excludes Mini/ACT-896.

## Maturation plan

- **test-agent-live:** hermetic schemas/evaluators/fake browser only.
- **dev-agent-live:** dark; compute would-admit, would-route, provider/privacy verdict,
  would-lease and would-observe; no profile activation, browser launch, capture or
  input.
- **dark-window:** seven days and ≥100 representative legacy one-shot operations across
  every supported framework; zero false allows, forbidden fields, or coverage gaps.
- `observe-only agent-profile canary`: real fenced seat, exact initial load,
  DOM/masked crop only on an agent-owned test profile; stop/revoke/contention/
  partition drills green.
- `operator-profile canary`: separately signed operator-profile mandates after all
  prior privacy criteria; still no input/effects. The implementation/maturation run
  **ends** after producing the Phase-3 evidence package. Phase 4 begins only as a new
  operator-triggered run after mandate issuance; it is never a mid-run approval pause.
- **fleet:** omitted/dark by default; grant/agent/machine/profile scoped only. Any fleet
  enablement requiring operator authority is likewise a separate operator-triggered
  run, never a continuation waiting mid-run.
- **graduation criterion:** 30 days, zero unauthorized effects, input interleaving,
  privacy/audit leaks, forbidden provider fallback or ambiguous replay; 100% stop/
  revoke drills within 10s.

### Phased build plan

Phase 0 audits/hardens the named MandateStore/MandateGate, generalized portable
mandate, profile/lease/hook/provider foundations and produces the entrypoint artifact.
Failure blocks and returns to spec convergence—it never selects a different store.
Phase 1 adds schemas, closed registries, dark evaluator, audit encoder and projections.
Phase 2 adds lease broker/fence and generalized mandate/auth-lease protocols, still
dry-run. Phase 3 runs agent-profile observe-only. Phase 4 runs separately ratified
operator-profile observe-only. Input/effects are not a Phase of this spec.

Availability publication failure uses exponential backoff (1s→60s), 10 attempts/10m,
keyed dedupe, 15m breaker and recovery probe; drive-status uses the same. Auth/seat
heartbeat stops on first failure. Dark reads at most once/10s, 100 samples/drive,
seven days. Sustained-rejection tests prove each loop's attempts/cost settle.

## Acceptance matrix

- Scope/property fuzz: mandate, URL/IDNA/port, host/principal/profile/provider,
  purpose/topic and ceiling escape.
- Authority: standing access never bypasses coherence/EOG/provider/privacy floors;
  all input/effect/full-frame/debug primitives are absent or rejected.
- Seat: cross-agent/project/framework contention; corrupt/lock/ABA/fence/crash/long
  call/operator takeover/profile-refresh races.
- Privacy: private inbox/OAuth/password-manager/payment/cross-tab/unknown-secret/PII
  canaries; only masked/capped provider payload; no weaker fallback.
- Multi-machine: portable mandate recipient/purpose substitution, replay/revoke/key
  rotation/issuer restart, projection monotonicity/caps/pressure, forbidden wire bytes.
- Audit: injection, keyed-digest guessing resistance, chain tamper, rotation, deletion
  failure, exact local/replicated field separation.
- Deployment: fresh install, partial migration, mixed/downgrade, dark→canary, active
  rollback, generated-vs-installed hook parity.
- Live test-as-self: busy seat, profile mismatch, revoke/partition mid-observation,
  remote route, provider refusal, crash during capture, operator takeover.

## Side-effects review

| Dimension | Disposition |
|---|---|
| Existing behavior | Dark does nothing; legacy one-shot path unchanged. |
| Cross-feature | Extends MandateGate, EOG, profiles, seat, MachineAuth/MeshRpc, router, audit/dashboard. |
| Migration | Atomic schema/manifest/hook/registry install; inert add-missing state. |
| Multi-machine | Signed exact-host mandate + bounded projections; local controller; no raw replication. |
| Security | Closed observation matrix, exact origin/principal/provider, short online leases, pre-model masking. |
| Rollback | Admission/auth stop before drain/fence; audit readable; profiles/cookies survive. |
| Observability | Hash-chained local metadata + capped latest projections, no sensitive content. |

Future build names `standingComputerUse.enabled` (omitted/dark) and mode in config
types/default migration/dev gate/guard manifest/coherence-critical manifest. Both
journal kinds, protocol/provider/tool registries, generated Claude/Codex hooks and
installed migrations land atomically. Mixed hashes/versions are ineligible.

## Standards engagement

P1/P18: entrypoint artifact+ratchet. P2/P7: signals never authorize; named arbiters
within deterministic floors. P4/P20: production hook/route/bytes and live
corroboration tests. P9/L15: structured signed intent at point of use. P19: bounded
retry/publish/heartbeat loops and sustained-pressure tests. P21/L3/L6/L11: explicit
topology, blocking foundation audit, side-effects review and fail-closed authority.
P5/L9: generated awareness plus substantive ELI16. P10/L5 and B14/B20/B22/B24/B28/
B30/B39: comprehensive-first, unknown holds, no identity guess/silent degradation,
bounded notification/effects, no stale-symbol authority, and dark maturation.

## Open questions

*(none)*

## Explicit exclusions

No runtime code in this PR. No Mini provisioning. No ACT-896.
