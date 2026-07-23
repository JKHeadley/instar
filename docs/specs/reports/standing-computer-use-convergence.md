# Convergence Report — ACT-903 Standing Computer-Use Capability

## ⚠ Cross-model review: DEGRADED — ALL ROUNDS (`degraded-all-rounds`)

Codex (`gpt-5.5`) and Gemini (`gemini-3.1-pro-preview`) were both detected and
attempted on every reviewable-body revision. Every attempt timed out. The spec
therefore converged through the six required internal perspectives and repository
standards checks without a successful external opinion. This reduced-assurance state
is disclosed here and in the spec frontmatter.

The Standards-Conformance Gate was invoked in every round but was unavailable because
the local Instar server on port 4044 was not running. The deterministic
multi-machine-marker lint ran and passed on the converged body.

## ELI16 overview

ACT-903 changes computer use from an accidental session feature into a bounded,
operator-signed standing capability. The first version is intentionally narrow: it
can open one exact, approved page and read a small DOM summary or masked screenshot
crop. It cannot click, type, submit, navigate further, transfer credentials, control
the desktop, or perform an external effect.

The design extends Instar's signed Coordination Mandates, Playwright profile registry,
host-wide operator-seat lease, external-operation gate, provider routing, MachineAuth
mesh, coherence journal and dashboard. It creates no parallel browser or permission
stack. Cookies and raw screen data stay on the physical seat host; only capped signed
availability/status and closed structured outcomes cross machines.

The safety cost is deliberate. Existing fail-open lease/hook edges must be repaired
before canary authority. Every drive is continuously fenced, every observation has a
short online authorization lease, the acting identity is corroborated rather than
trusted from profile prose, provider privacy is signed and freshness-checked, and
revocation has an honest ten-second partition bound.

## Original vs converged

The first draft described a broad standing GUI capability with `observe-only`,
`reversible-ui`, and externally gated effects. Review found that this hid multiple
authority seams. The converged v1 is observation-only; any input/effect is a new
converged specification.

Originally, the grant store was left to implementation. The final design selects the
existing PIN-authored, signed `MandateStore`/`MandateGate`, binds one exact requester
and seat host, and specifies portable delivery plus a five-second online lease from
the issuing machine.

Originally, profile ownership could have relied on the advisory profile registry and
profile switching happened before seat acquisition. The final design takes acting
principal only from signed mandate bounds, corroborates it through closed service
verifiers, and performs profile transition inside the same continuous fenced seat.

Originally, remote routing did not say where screen interpretation ran. The final
design runs the controller on the credential-bearing seat host, constrains the
external model provider through signed privacy posture, and prevents raw screen/DOM
data from entering MeshRpc or replicated state.

Originally, page creation, origin matching, provider privacy, DNS policy, auxiliary
identity verification, and GET side effects were underspecified. The final design
defines exact URL canonicalization, no-query grants, pinned public-address networking,
one EOG-judged initial GET, one separately enumerated verifier GET, no subresources or
JavaScript, and hard network quiescence on stop/revoke.

Originally, the existing seat lease's fail-open/corruption/fencing gaps were merely
listed for possible follow-up. They are now a blocking Phase-0 exit gate backed by a
complete entrypoint inventory and production-positive-control CI ratchet.

## Iteration summary

| Iteration | Reviewers who flagged | Material findings | Spec changes | Standards gate |
|---|---|---:|---|---|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons | 32 grouped into 17 themes | Selected signed mandates; observation-only scope; authority/effect separation; fenced seat; local-controller topology; bounded projections; foundation gate | unavailable: server down |
| 2 | all six | 16 grouped into 9 themes | Closed purpose/time/UI decisions; generalized mandate transport; exact status kind; decision rows; publisher brakes; removed stale effect/debug language | unavailable: server down |
| 3 | security, adversarial, decision-completeness, lessons | 8 grouped into 7 themes | Exact host; initial-load primitive; provider privacy bounds; exact origins; persistent-context ownership; no-query/public-DNS/network cancellation; arbiter evidence | unavailable: server down |
| 4 | security, adversarial, integration, decision-completeness, lessons | 1 | Added signed release-owned principal-verifier registry and separately gated auxiliary GET | unavailable: server down |
| 5 | decision-completeness, lessons | 1 | Corrected authenticated verifier GET from invariant to judgment-candidate | unavailable: server down |
| 6 | *(converged)* | 0 | none | unavailable: server down |
| 7 | *(converged; structural confirmation)* | 0 | parser-only subsection heading; no semantic change | unavailable: server down |
| 8 | *(converged; structural confirmation)* | 0 | parser-required H2 heading level; no semantic change | unavailable: server down |
| 9 | *(converged; structural confirmation)* | 0 | maturation/phased heading normalization; no semantic change | unavailable: server down |
| 10 | *(converged; hard-cap final)* | 0 | canonical maturation field formatting; no semantic change | unavailable: server down |

All changed-body rounds attempted both external families. Codex and Gemini timed out
in every round; no unchanged-body delta skip was used.

## Full findings catalog

### Round 1

- **Critical — advisory identity used as authority.** Resolved by making the signed
  mandate's acting principal authoritative and profile metadata display-only.
- **Critical — profile activation outside seat serialization.** Resolved by a fenced
  `profile-transition` phase held through refresh and re-verification.
- **Critical — impossible partition revocation claim.** Resolved with five-second
  issuer-signed online auth plus five-second atomic-operation deadline; honest 10s.
- **High — grant substrate deferred.** Resolved by selecting MandateStore/MandateGate.
- **High — free-form purpose/effect scope.** Resolved with closed structured bounds
  and observation-only v1.
- **High — no observation privacy authority.** Resolved with deterministic privacy
  floor plus EOG and minimization arbiters.
- **High — remote observation topology absent.** Resolved with seat-host controller.
- **High — same-UID/file lease overclaim.** Boundary narrowed; broker/fence and
  fail-closed tamper behavior required.
- **High — lease gaps/fail-open hook foundation.** Converted to blocking Phase-0 gate.
- **High — manual operator contention overclaim.** Narrowed to compliant callers and
  a managed operator-seat toggle.
- **High — unbounded replication/retry.** Added cardinality/byte/TTL/token/backoff/
  breaker and cached-union limits.
- **High — mixed-version/rollback incomplete.** Added coherence-manifest eligibility,
  atomic migrations and ordered pool rollback.
- **High — page drift/approval binding incomplete.** V1 removed inputs and requires
  fresh bounded observation plans.
- **Medium — audit secret sink/digest weakness.** Added keyed digests, hash chain,
  caps, retention and fail-closed degradation.
- **Medium — page ownership unknown.** Added immutable drive-created page registry;
  never adopt/close pre-existing pages.
- **Medium — credential-trigger ambiguity.** V1 never enters credentials; page can
  emit only a typed hold.
- **Medium — side-effects/standards artifacts missing.** Added seven-dimension review,
  explicit standards engagement and entrypoint artifact.

### Round 2

- **High — no executable initial-page path.** Added broker-owned initial load.
- **High — delivered mandate was account-follow-me-specific.** Specified backward-
  compatible generalized portable mandate and point-of-use protocol.
- **High — drive status kind unspecified.** Added independent bounded status kind.
- **High — stale store/epoch/effect language.** Removed contradictory contract text.
- **High — closed tool/principal classifiers incomplete.** Added exact tool and
  service-verifier registries.
- **High — judgment arbiters lacked comparative evidence.** Added shadow sample,
  confidence, provenance, default comparison and bench ingestion.
- **High — availability publisher lacked P19 brakes.** Added backoff/breaker/dedupe
  and sustained-rejection proof.
- **High — model-processing boundary hidden.** Added signed provider privacy posture.
- **High — exact host/party mismatch.** One mandate now binds one exact host.

### Round 3

- **Critical — GET is itself effectful.** Reclassified initial load through EOG with
  conservative block/approval and a highly restrictive request floor.
- **High — verifier names were symbolic.** Added two-signal, fresh, exact contracts.
- **High — provider privacy registry had no provenance.** Made it signed-release,
  primary-evidence hashed, reviewed, expiring and coherence-checked.
- **High — operator canary was a hidden mid-run gate.** Made Phase 4/fleet separate
  operator-triggered runs.
- **High — isolated context could not inherit login.** Corrected to a drive-owned page
  in the persistent profile context without cookie serialization.
- **High — query URL could persist a secret.** Queries/userinfo/fragments forbidden.
- **High — DNS rebinding/network lifecycle incomplete.** Added pinned public-address
  policy, no subresources/workers/sockets and hard cancellation/quiescence.

### Round 4

- **High — identity verifier contradicted one-GET floor.** Added operator-visible
  endpoint bounds, signed `PrincipalVerifierRegistry`, and one separately gated,
  pinned, capped, in-memory auxiliary request.

### Round 5

- **High — verifier GET misclassified invariant.** Corrected to
  `judgment-candidate`: exact deterministic request floor plus EOG arbiter and
  approval/block fallback.

### Rounds 6–10

All six internal perspectives returned zero material findings. Final
decision-completeness counts: 12 frontloaded decisions, 0 cheap tags, 0
contested-then-cleared, 0 open or buried decisions. Round 7 re-confirmed zero after a
subsection heading was added solely to terminate the decision-table parser scope;
Round 8 confirmed the parser-required H2 level; Round 9 confirmed the exact
maturation-plan heading required by the rollout validator.
Round 10 confirmed its canonical field labels at the convergence hard cap.

## Convergence verdict

Converged at iteration 10. The final five rounds produced no material findings, the open
questions section is empty, all decision points are classified, multi-machine
locality lint is clean, and the ELI16 companion is substantive. The spec is ready for
review as a design-only proposal.

Assurance disclosure: cross-model review is `degraded-all-rounds` because every
detected Codex and Gemini attempt timed out, and the constitutional gate was
unavailable because the local server was down.
