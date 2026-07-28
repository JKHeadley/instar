# Side-Effects Review — correction-derived-hardening

Spec: `docs/specs/correction-derived-hardening.md` (B21_USER_TASK_SUBSTITUTION
tone-gate rule + owned-identities self-unblock probe). CMT-904.

## Phase 1 principle check (recorded)

Both changes touch decision-point-adjacent surfaces, and both comply with
signal-vs-authority by construction:

- **Change A** adds a meaning-judged rule to the EXISTING single outbound
  authority (the tone-gate LLM). No deterministic detector gains blocking
  power; no new authority is created.
- **Change B** adds an evidence-producing probe to a RECORDER
  (SelfUnblockChecklist). The settle judgment stays with BlockerLedger's
  injected Tier-1 authority; the probe cannot block anything.

## 1. Over-block

- **A:** the risk is citing B21 on legitimate walkthroughs. Mitigated by four
  explicit carve-outs (user-asked, structurally-human-reserved incl.
  dashboard-PIN actions, single one-tap link/code, discussion), a
  false-negative severity bias, and the "the page the agent built IS the one
  tap's destination" clarification so a Secret-Drop link + its form fields is
  never counted as multi-step. Worst case remains a held message with a
  concrete suggestion, visible in review history — recoverable in one resend.
- **B:** the second-pass reviewer found the real risk here: a STALE entry
  advertising a phantom credential would make every run non-exhausted, and
  BlockerLedger's settle gate would then refuse a true-blocker settle FOREVER —
  static declaration holding blocking authority over the escalation path.
  Closed with the credentialRef LIVENESS GATE (file-stat / vault-key-presence
  before any tag is advertised; unverifiable entries contribute nothing) plus
  an explicit test that a fully-stale registry still EXHAUSTS. Residual: a
  live-but-revoked credential (file exists, credential dead) still biases
  toward a wasted self-attempt — that direction is recoverable (the attempt
  fails, gets recorded, and the settle path accepts a failed attempt on an
  exhausted re-run once the operator prunes or the ref is removed), and is the
  same residual own-vault has for a revoked-but-present key.

## 2. Under-block

- **A:** a procedure phrased as pure narrative ("the fix lives in the app
  config page under OAuth") without imperative steps may evade the rule; the
  meaning-judged framing (not literal step-counting) is the mitigation, and the
  severity bias accepts residual under-blocking as the safe direction.
- **B:** an UNREGISTERED identity stays invisible — the registry only works if
  agents register what they create. Addressed at the behavior layer (template
  trigger + migrator section) rather than by scanning (a filesystem sweep for
  credentials would violate the provider hard-safety rules).

## 3. Level-of-abstraction fit

- **A:** correct layer — the tone gate is the single outbound authority and
  already owns the sibling anti-patterns (B17 deferral, B19 parking). A
  PreToolUse hook or a deterministic phrase list would be the wrong layer
  (string-matching an infinitely-rephrasable intent).
- **B:** correct layer — the checklist is THE exhaustion oracle
  (BlockerLedger's settle gate consumes its runs); a memory note or CLAUDE.md
  prose alone would be willpower, not structure.

## 4. Signal vs authority compliance

Compliant (see Phase 1 above). Reference: `docs/signal-vs-authority.md`. The
B21 rule text is judgment guidance to the existing authority; the
owned-identities provider is a signal producer feeding a recorder whose
authority lives elsewhere.

## 5. Interactions

- **A/B17-B19 overlap:** handled explicitly in the prompt — extended citation
  precedence `B15 > B16 > B17 > B18 > B21` plus a RELATIONSHIP paragraph
  (B17 = deferring claiming a person is required; B19 = passive parking;
  B21 = actively supplying the procedure). The b18 test's substring assertion
  on the old chain still passes (the new chain contains it).
- **A/ratchets:** `gate-prompts-judge-by-meaning` (RULE_CLASSES keyset ==
  VALID_RULES) and `tone-gate-rule-id-contract` pass with B21 in both
  registries — verified green.
- **B/runner:** the defensive full-coverage assert in
  `buildProductionProbeProviders` holds (source + provider land together);
  the canonical-order test updated for the new position (after own-vault).
  Short-circuit semantics unchanged.
- No double-fire: B21 has no deterministic detector, so no signal path exists
  to race with; the owned-identities probe is read-only over one small file.

## 6. External surfaces

- **A:** visible to users only as (rarely) a held message + rewritten resend —
  the same surface every gate rule already has. `/metrics/features` and the
  review history show citations for observability.
- **B:** a new optional per-agent file `.instar/owned-identities.json`
  (agent-authored; absent = today's behavior). `/blockers/self-unblock-runs`
  entries now include an `owned-identities` probe row. CLAUDE.md gains a
  section on existing agents via the migrator (append-only, content-sniffed).
- No timing/conversation-state dependence beyond the gate's existing review
  flow.

## 7. Multi-machine posture

**Machine-local by design, both changes.** The gate rule is code shipped
identically to every machine (version parity). The owned-identities registry is
per-agent-home and machine-local like the vault and the playwright-profile
registry: entries carry machine-local credential POINTERS, and an entry without
its credential is a claim the checklist cannot act on. Cross-machine
replication is deliberately excluded (documented in the spec); the probe's
absence of a registry on a standby machine degrades to exactly today's
behavior. No user-facing notices are emitted by either change (no one-voice
concern); no durable state strands on topic transfer (the registry is not
topic-scoped); no URLs are generated.

## 8. Rollback cost

- **A:** one commit removing B21 from the three registries; no data migration;
  until then the worst failure is a false hold, immediately visible.
- **B:** one commit removing the source + provider; the registry file becomes
  inert data. The appended CLAUDE.md section is prose; the migration is
  content-sniffed and simply stops matching. Hot-fix release suffices for
  both; no agent state repair.

## Class-Closure Declaration

- `unbounded-self-action`: **n/a** — neither change performs or schedules any
  self-triggered action. Change A adds prompt content to an existing gate's
  single per-message review; Change B adds one bounded local file read inside
  an existing on-demand checklist run. No loops, no cadences, no kill/spawn/
  notify authority anywhere in the diff.

## Spec-convergence hardening (round-1 findings folded in)

Beyond the second-pass exchange below, the full /spec-converge run (2 rounds,
six internal perspectives + codex-cli:gpt-5.5 external both rounds, conformance
gate 0 flags both rounds) drove further hardening before commit: agent-home
JAIL on file: refs (escape refused before any stat), 256 KB / 500-entry / 128-
char bounds with a stat cache (rule-(b) compliance), loud server-log warning on
a present-but-unparseable registry (the silent-recurrence trap), B21
capability-uncertainty default-PASS + widened human-only carve-out, the
wiring-integrity ratchet test, canonical scope-tag convention in the template +
migrator text, and honest disclosure of the resolving-but-stale residual and
the B21 token cost. Full catalog:
`docs/specs/reports/correction-derived-hardening-convergence.md`.

## Operator design redirect (2026-07-18 23:00 PDT, incorporated pre-merge)

Mid-build the operator directed that B21 must NOT hold blocking authority:
outbound sentinels nudge a drafted message once; the agent decides; overrides
are recorded. Implemented as the structural `RULE_DISPOSITIONS` split (B21 as
`advisory`; the seam returns `tone-gate-advisory`/notSent with the
`toneAdvisoryAck` resend path; the override is logged as `advisoryOverridden`
for the decision-quality meter; the ack can never override a blocking rule).
This REDUCES Change A's authority below what the earlier sections review
(their over-block analyses become strictly conservative). Migration of
existing judgment rules to advisory is recorded in the spec as tracked intent
(CMT-904).

## Feature-delivery ratchet compliance (post-suite fix)

The whole-tree feature-delivery-completeness ratchet caught that the new
migrateClaudeMd section was untracked: registered `'owned-identities'` in
featureSections and added the migrateFrameworkShadowCapabilities marker so
Codex/Gemini agents (which provision identities too) also learn the registry —
without the marker, the founding wrong-escalation would recur on non-Claude
frameworks (the exact Secret-Drop/Commitments gap class the ratchet was built
from).

## Second-pass review

Required (the change touches a gate). Performed as a REAL independent
fresh-context reviewer run (claude one-shot over the artifact, spec, and full
diff), 2026-07-18.

**Round 1 — Concern raised:** "the owned-identities probe is the only one of
the ten sources that can force `exhausted:false` on pure static declaration
with no liveness check … a stale entry whose scopeTag matches the blocked
target … means the agent cannot record a true-blocker and cannot escalate to
the operator even after a genuine failed self-attempt — a self-perpetuating
loop. This is precisely the 'brittle logic gaining blocking authority' pattern
the audit targets." Recommended an existence check of the credentialRef
pointer before advertising (a stat, not a value read).

**Iteration:** the recommended design was adopted in full — the credentialRef
liveness gate (file: stat with agent-home-relative resolution; vault: key-name
presence via getVaultKeys; unknown/missing schemes advertise nothing), plus
two new tests (stale registry advertises nothing; a full checklist run over a
fully-stale registry still exhausts) and the spec/artifact text corrected to
stop claiming the bias was purely toward wasted self-attempts.

**Round 2 — Concur:** re-review of the updated diff confirmed the stranding
path is closed and no new authority was created (the liveness check is a
boolean stat feeding a recorder; the settle authority is unchanged).
