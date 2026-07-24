---
title: Correction-Derived Hardening — B21_USER_TASK_SUBSTITUTION + owned-identities self-unblock probe
status: draft
owner: echo
created: 2026-07-18
parent-principle: "Structure beats Willpower"
approved: true
approved-basis: "Operator blanket pre-approval for drive 6, 2026-07-18 (topic 29723: all specs and decisions pre-approved; corrections-become-infrastructure directive 21:56 PDT) — same basis as PR #1512/#1516/#1517"
review-convergence: "2026-07-19T06:19:17.250Z"
review-iterations: 3
review-completed-at: "2026-07-19T06:19:17.250Z"
review-report: "docs/specs/reports/correction-derived-hardening-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Correction-Derived Hardening

Two structural changes, each derived from a direct operator correction on
2026-07-18 (topic 29723). The operator's meta-directive that same evening:
"Every correction I make to you should be a learning experience that results in
infrastructure change." This spec is that directive executed: both corrections
become code the fleet inherits, not memories one agent keeps.

## Origin corrections (verbatim)

1. **21:49 PDT** — after the agent offered the operator a manual Slack-portal
   click checklist as an unblock option: *"This is an unacceptable solution. ANY
   solution that requires step by step clicking on the user side is
   UNACCEPTABLE. Instar agents should ALWAYS assume responsibility when browser
   tasks are involved. The ONLY thing you should need from me are the
   credentials needed for YOU to perform these tasks."*
2. **21:52 PDT** — after the agent asked which account manages a workspace the
   agent itself had provisioned: *"I don't know which account manages the
   'SageMind Live Test workspace' because you are the one that set it up."* The
   agent's self-unblock "exhaustion" verdict had enumerated browser sessions,
   vault tokens, and its own app — but never the five test identities the agent
   itself had provisioned, one of which OWNED the workspace in question. The
   escalation to the operator was wrong by construction.

## Change A — `B21_USER_TASK_SUBSTITUTION` (MessagingToneGate rule)

### What

A new behavioral-judgment rule in the outbound tone gate
(`src/core/MessagingToneGate.ts`), citable as `B21_USER_TASK_SUBSTITUTION`:

> The candidate hands the USER a multi-step procedure — portal click-paths, UI
> navigation steps, command sequences — for work the AGENT could perform itself
> given at most a credential or an approval.

When self-unblock exhausts, the legitimate escalation shapes are: (a) a yes/no
approval, (b) a credential request (e.g. a Secret Drop link), (c) a mid-flow
challenge code. A procedure for the human to execute is never an escalation
shape. Offering a click list "as an option, whenever convenient" alongside a
legitimate path is exactly the failure mode — the option itself outsources
agent work to the human.

### Rule mechanics (mirrors B15–B18 conventions)

- Added to `VALID_RULES`, to `RULE_CLASSES` as `behavioral-judgment`, and as a
  prompt bullet in `renderToneGatePrompt` after B20. No deterministic detector
  and no upstream signal — the intent is infinitely rephrasable and judged by
  MEANING, exactly like B15–B18 ("Intelligent Prompts — An LLM Gate Must Not
  String-Match").
- **Carve-outs (do NOT cite):**
  - The user explicitly asked to do it themselves, to learn the steps, or asked
    for a walkthrough (including mobile-friendly walkthroughs).
  - The steps are for an action structurally reserved to the human: a
    dashboard-PIN-gated action, a physical/hardware action, a payment/legal
    authorization, a CAPTCHA/human-presence challenge, or the decision/approval
    itself.
  - A single one-tap action: open a link the agent minted for them (Secret
    Drop, dashboard, private view), tap approve/deny, or supply one challenge
    code. One tap is a Rung-1/2 ask, not a procedure.
  - The action is one the agent GENUINELY LACKS THE MEANS to perform even with
    a handed-over credential: a non-delegable personal credential/session (the
    user's personal inbox, personal-device 2FA/passkey, person-bound accounts)
    or a third-party surface structurally requiring the account owner.
  - **Capability-uncertainty default (round-1 adversarial + codex finding):**
    the gate usually cannot see the agent's real capability inventory — when it
    cannot tell whether the agent has (or could request) the means, it defaults
    to PASS; it cites B21 only when the message itself makes agent-doability
    plain (a credential path or agent-held session named alongside the click
    list, or steps on a surface agents demonstrably drive: app-config portals,
    cloud consoles, settings pages).
  - The message is DISCUSSING this rule or a past instance (memo, not a live
    instance).
- **Precedence / de-confliction:** citation order extends to
  `B15 > B16 > B17 > B18 > B21`. B17 covers *deferring a task claiming a person
  is required*; B21 covers *supplying the human a procedure* — the shape that
  survives B17's carve-outs when the message ALSO contains a legitimate
  escalation (the founding case offered a credential path AND a click list; the
  click list is the violation). B19 covers passive parking of follow-through;
  B21 is the active-instruction sibling; where both fit, the precedence chain
  and specificity note in the prompt resolve it.
- **Severity:** favor FALSE-NEGATIVES, like every behavioral rule — a genuine
  human-only walkthrough must pass; block only the clear pattern of agent-doable
  work handed to the human as steps.

### Disposition: ADVISORY-ONLY (operator directive, 2026-07-18 23:00 PDT)

Mid-build the operator set the architectural direction for outbound sentinels:
they review a DRAFTED message pre-send and get ONE opportunity to NUDGE the
agent — name the pitfall, explain why — and the AGENT holds the ultimate
decision to revise or proceed. Blocking is too much power (it has burned us:
path-blocking of content the user asked for); post-send review is too late.
Agent overrides are RECORDED — a signal for the decision-quality meter, never
authority.

B21 therefore ships with a structural `advisory` disposition from day one:

- A per-rule `RULE_DISPOSITIONS` map (`'blocking' | 'advisory'`) with the
  ratchet invariant key-set == `VALID_RULES` (test-enforced). B21 is the first
  `advisory` rule; every existing rule keeps `blocking` until its own
  migration spec.
- On an advisory citation the seam (`evaluateOutbound`) returns
  `422 tone-gate-advisory` with `notSent: true`, the citation + reasoning, and
  a deterministic resend path: re-send unchanged with
  `metadata.toneAdvisoryAck: "<full rule id>"` to acknowledge and deliver. The
  override is recorded in the tone-gate decision log
  (`advisoryOverridden: true`) — joinable by the decision-quality meter.
- The ack can NEVER override a blocking rule (test-enforced), and an advisory
  rule can never produce a terminal `tone-gate-blocked` (the seam split is the
  invariant; integration-tested through the real `/telegram/reply` route).
- **Ack-contract seam scope (stated honestly):** the acknowledgment metadata
  is threaded on the CONVERSATIONAL seams — `/telegram/reply` and the Slack
  reply route — where a live agent receives the nudge and decides.
  Non-conversational callers (post-update, digests) receive the distinct
  `tone-gate-advisory` reason and treat not-sent the same way they treat any
  gate refusal today; those sends run without a live agent to exercise a
  nudge, so advisory-vs-blocking is behaviorally equivalent on them by
  construction, not by omission.
- **Migration intent (tracked):** existing judgment-shaped rules (B15–B19 and
  the paths/technical-detail artifact classes) are candidates to migrate to
  advisory-with-audited-override in a follow-up spec; ONLY mechanical
  secret-VALUE leaks keep a hard blocking floor. <!-- tracked: CMT-904 -->

### Signal-vs-authority

No new authority is created — and under the advisory disposition B21 holds
even LESS than the gate's usual power: it can only nudge-and-return; the agent
retains delivery authority with a recorded override. No deterministic detector
gains blocking power.

### Cost + exposure (round-1 scalability finding, stated honestly)

The rule bullet adds a permanent ~350-token cost to EVERY outbound-message
review, and it ships live fleet-wide on release with no dark/soak stage — but
under the ADVISORY disposition its worst failure is a nudge the agent
acknowledges past (one extra round-trip), never a withheld message: strictly
less power than every prior gate-rule ship (B19, B20 shipped as blocking). The
soak mechanism is the severity bias + the visible decision log including
recorded overrides. Rollback is a one-commit registry removal.

## Change B — `owned-identities` self-unblock probe

### What

A tenth probe source in the Self-Unblock checklist
(`src/monitoring/SelfUnblockChecklist.ts` + `SelfUnblockProbeProviders.ts`):
**identities the agent itself provisioned** — test users, service accounts,
workspace owners — recorded in a per-agent registry file
`.instar/owned-identities.json`.

The 2026-07-18 incident proves the gap: the checklist's Rung-0 enumeration
(vault → Bitwarden → cloud CLIs → MCP → browser → controlled resources) can all
come up empty while the agent OWNS the controlling identity for the blocked
resource, because provisioned identities lived only in ad-hoc files the
checklist never consults. An exhaustion verdict that skips the agent's own
creations escalates to the operator for access the agent already has.

### Registry shape

`.instar/owned-identities.json` — a JSON array of entries:

```json
[
  {
    "identity": "owner-test@sagemindai.io",
    "service": "slack-workspace",
    "roles": ["owner"],
    "scopeTags": ["slack:T0BA1DR0U3D", "google:sagemindai.io"],
    "credentialRef": "file:.instar/slack-live-test/test-users.json#owner-test",
    "note": "SageMind Live Test workspace owner (provisioned 2026-06)",
    "createdAt": "2026-06-12T00:00:00Z"
  }
]
```

- `credentialRef` is a POINTER (where the credential lives), never a value.
- The registry is agent/operator-authored declaration data — the same trust
  class as `credentialScopeTags` config (rule (c) of the provider hard-safety
  rules): relevance stays declared + fail-closed, never inferred.

### Provider mechanics

- Source id `'owned-identities'`, positioned immediately after `'own-vault'`
  (same locality class), timeout class `local`.
- The provider reads the registry via an injected `ownedIdentitiesPath` dep
  (production: `<instarDir>/owned-identities.json`), with a 256 KB read cap and
  a hard 500-entry processing bound (entries beyond the cap are counted, not
  processed — rule (b): never an unbounded loop; a per-path stat cache
  deduplicates liveness checks). Missing or unreadable file → `reachable:
  false` with a plain detail (fail-closed, mirrors own-vault). A
  PRESENT-but-unparseable registry (malformed JSON / non-array root) is the
  silent-recurrence trap — it fails closed AND logs a loud bounded server-log
  warning naming the file, so the founding bug cannot silently return via a
  corrupted registry (round-1 adversarial finding).
- **String hygiene:** every name/tag read out of the registry is control-char-
  stripped and clamped to 128 chars before it can ride the probe result into
  the settle authority's untrusted-data envelope (round-1 security finding).
- **File-ref jail:** `file:` refs resolve ONLY inside the agent home —
  absolute paths outside it and `..` escapes never resolve (checked before any
  stat). The liveness bar is honestly WEAK — existence of the pointed-to file,
  not credential validity — and the jail keeps it from being satisfiable by
  arbitrary host files (round-1 security finding).
- **Scope-tag canonicalization (frontloaded):** blocker targets and registry
  `scopeTags` MUST use the same canonical `service:scope` form the checklist's
  deterministic `isScopeRelevant` already parses (same-service + domain-scope
  match; e.g. `slack:T0BA1DR0U3D`, `cloudflare:dawn-tunnel.dev`). Register the
  form the blocker target will use — an opaque ID, not a display name. The
  CLAUDE.md registration trigger states this convention.
- Advertised tags are EXACTLY the union of each LIVE entry's explicit
  `scopeTags` strings. **Liveness gate (added in second-pass review):** an
  entry advertises ONLY when its `credentialRef` pointer RESOLVES right now —
  `file:<path>` must stat (relative paths resolve against the agent home; the
  `#fragment` is ignored), `vault:<key>` must be a present vault key NAME; a
  missing ref or unknown scheme contributes nothing (fail-closed). Without
  this, a STALE entry could advertise a phantom credential forever —
  `holdsRelevantCred:true` → `exhausted:false` → BlockerLedger refuses the
  true-blocker settle → the agent could never escalate: static declaration
  would hold blocking authority over the escalation path. The liveness check
  is a stat/name-presence only — no secret value is ever read. No inference
  from `service`/`identity`, and no other field is ever read into the result —
  an entry carrying a stray password/token-like field can never leak it into
  tags or detail (secret-non-leak test enforced).
- `detail` reports counts + identity NAMES only (e.g.
  `3 owned identities: owner-test@…, admin-test@…`), never credential material.
- The defensive full-coverage assert in `buildProductionProbeProviders` keeps
  holding: source and provider land in the same commit.

### Behavioral contract (the registration half)

A registry no one writes is the same gap re-created, so the standard is stated
where agents live:

- The CLAUDE.md template (`src/scaffold/templates.ts`, Self-Unblock section)
  gains: Rung 0 explicitly includes "identities you yourself provisioned (your
  owned-identities registry)", plus the proactive trigger: **the moment you
  provision a test/service identity, register it in
  `.instar/owned-identities.json`** — with names and pointers, never secret
  values.
- Migration parity: `migrateClaudeMd` follows its established APPEND-ONLY
  convention (it never edits existing sections in place): existing agents get a
  content-sniffed appended `### Owned-Identities Registry` section carrying the
  Rung-0 extension + registration trigger; fresh installs get the same content
  inline in the template's Rung-0 line. The prose therefore lives in slightly
  different positions on old vs new installs — same awareness, structurally
  divergent placement, accepted (round-1 integration finding, reconciled to
  the append reality).
- **Capability ≠ authority (round-1 decision-completeness finding):** an owned
  identity satisfies Rung 0 for ACCESS, never for AUTHORITY — acting AS an
  owned identity on an irreversible / cost-bearing / out-of-scope /
  policy-sensitive action still hits the Rung FLOOR (approval) and every
  existing gate (external-operation, coherence, mandate). The registry adds
  evidence of means, not permission.
- **No independent off-switch (stated honestly):** the probe rides the
  existing `monitoring.blockerLedger.*` gate like every other probe source;
  it cannot be disabled while keeping the ledger. Rollback is source removal.
- **Structural registration path is a TRACKED follow-up** — the CLAUDE.md
  trigger is prose, and prose is willpower; the structural fix (provisioning
  helpers writing the registry at creation time) is registered as CMT-905.
  <!-- tracked: CMT-905 -->

### Signal-vs-authority

The checklist RECORDS and STRUCTURES; the settle judgment stays with
BlockerLedger's injected authority. The new probe adds evidence, not blocking
power. A false `holdsRelevantCred: true` (over-advertised tag) biases the agent
toward self-unblocking — the failure mode is a wasted self-attempt, never a
wrong block.

## Decision points touched

| Decision point | Classification | Notes |
|---|---|---|
| B21 citation (tone gate advisory/pass) | judgment-candidate | Floor: bounded action space {pass, advisory-nudge-with-suggestion} — B21 structurally CANNOT produce a terminal block (RULE_DISPOSITIONS + seam split, test-enforced); conservative default = PASS (favor false-negatives + capability-uncertainty default, explicit in the rule text); fallback ladder = the gate's existing degradation ladder ending at the deterministic leak floor (which knows nothing of B21 → a degraded gate PASSES B21-shaped messages — the safe direction). Arbiter: the AGENT holds the ultimate delivery decision (operator directive 2026-07-18); the tone-gate LLM only nudges; overrides are recorded for the decision-quality meter. |
| owned-identities `holdsRelevantCred` | invariant | Deterministic by design: the checklist's existing `isScopeRelevant` match over the liveness-gated, explicitly-declared scopeTags — never an LLM, never inference. The probe produces evidence only; settle authority (BlockerLedger's Tier-1 gate) is unchanged. |
| credentialRef liveness gate | invariant | A boolean stat / vault-key-name presence check (fail-closed, jailed to the agent home). A false NEGATIVE biases toward exhaustion → escalation (recoverable). HONEST LIMIT (round-1 decision-completeness finding): a ref that RESOLVES but whose credential is stale/irrelevant still advertises its tags → `holdsRelevantCred:true` → not-exhausted → BlockerLedger refuses the true-blocker settle until the entry is pruned. This escalation-path coupling is INHERITED from the foundation (the ledger's refuse-settle-while-not-exhausted design — a deterministic signal gating an escalation surface); the spec surfaces rather than hides it, and recovery is deleting/fixing the entry (documented in the CLAUDE.md section). The liveness gate narrows the trap from "any stale entry, forever" to "a resolving-but-stale entry, until pruned". |

## Frontloaded Decisions

- Registry location + shape: `.instar/owned-identities.json`, JSON array, fields as specced (decided here; cheap to extend additively later behind the same fail-closed parser).
- Liveness bar: pointer-resolves (stat / key-name presence), NOT credential validity — validity requires a value read the hard-safety rules forbid; a live-but-revoked credential biases toward a recoverable wasted attempt (documented residual).
- Migration style: append-only content-sniffed CLAUDE.md section (the established migrateClaudeMd convention), not an in-place Rung-0 edit.
- B21 precedence position: last in the chain (B15 > B16 > B17 > B18 > B21) — B21 is the residue-catcher for messages whose escalation is otherwise legitimate.

## Open questions

*(none)*

## Test plan

- `tests/integration/telegram-reply-b21-advisory.test.ts` — the advisory
  contract end-to-end through the REAL route: B21 citation leads to 422
  `tone-gate-advisory` + notSent (message held for the agent, not dropped);
  resend with `toneAdvisoryAck` delivers unchanged; the ack can NEVER
  override a blocking rule (B17 stays hard).
- `tests/unit/messaging-tone-gate-b21.test.ts` — disposition ratchet
  (RULE_DISPOSITIONS keyset == VALID_RULES; B21 advisory, all others
  blocking); a B21 citation carries `advisory: true`, a blocking citation does
  not; plus, mirroring the b18 file: rule
  text renders in every prompt; carve-outs render; extended precedence chain
  renders; B21 is citable without `invalidRule`; a pass verdict flows through.
- `tests/unit/gate-prompts-judge-by-meaning.test.ts` +
  `tests/unit/tone-gate-rule-id-contract.test.ts` — the existing ratchets must
  pass with B21 in both registries (no test edits expected; the ratchet derives
  from the registries).
- `tests/unit/SelfUnblockProbeProviders.test.ts` — new cases: live registry →
  reachable + exact declared tags from LIVE entries only; stale/dangling refs
  → nothing advertised AND a full checklist run still EXHAUSTS (the stranding
  path is closed); registry absent/malformed → unreachable; an entry with a
  stray `password` field → the value appears in NO output field; live identity
  names appear in detail; the credential POINTER itself is not surfaced.
- `tests/unit/SelfUnblockChecklist.test.ts` — taxonomy now includes
  `owned-identities` in order (after own-vault); a matching owned-identity tag
  short-circuits the run as a self-unblock hit.
- `tests/unit/PostUpdateMigrator-ownedIdentities.test.ts` — the appended
  section applies once, is idempotent, content-sniff skips files already
  carrying "owned-identities", and the fresh-install template carries the
  Rung-0 line + trigger.
- **Founding-scenario reproduction (round-1 lessons finding, L7):** the
  checklist-level test uses the real incident shape — a registry entry for a
  workspace-owner identity with the workspace's opaque team-id scopeTag and a
  live file ref; `checklist.run` against that exact `slack:<team-id>` target
  must come back NOT exhausted (the agent self-unblocks instead of escalating),
  and the fully-stale variant must exhaust (the stranding path is closed).
- **Jail + clamp tests:** an out-of-home `file:` ref never resolves (and is
  never statted); an oversized/control-char identity name is clamped before it
  rides the result.
- **Wiring-integrity ratchet (Testing Integrity Standard):** a test reads the
  single production callsite in `AgentServer.ts` and asserts
  `ownedIdentitiesPath` is threaded into `buildProductionProbeProviders` — the
  parent feature's founding regression class (provider exists, never wired)
  cannot silently return.

## Multi-machine posture

machine-local-justification: physical-credential-locality

Both changes are **machine-local by design**. The tone-gate rule is stateless
prompt content shipped in code (identical on every machine by version parity).
The owned-identities registry is per-agent-home, machine-local like the vault
and the playwright-profile registry: an identity provisioned from one machine
is registered where its credential pointer resolves. Cross-machine replication
of the registry VALUE is deliberately NOT included — the credentialRef pointers
are machine-local paths (physical-credential-locality), and a registry entry
whose credential is elsewhere advertises nothing under the liveness gate
(fail-closed on the peer, by construction). The round-1 integration reviewer is
right that the founding incident can recur CROSS-machine (machine B escalating
for an identity machine A owns); metadata-only WS2 replication
(identity/service/scopeTags with credentialRef stripped) is provably safe under
the liveness gate and is registered as a tracked follow-up rather than scoped
into this PR — it rides the replicated-store rollout machinery, a separate
subsystem with its own dark/dry-run ladder. <!-- tracked: CMT-906 -->

## Rollback

- Change A: remove the rule from the four registries (VALID_RULES,
  RULE_CLASSES, RULE_DISPOSITIONS, the prompt bullet) in one commit; no data
  migration. Under the advisory disposition the worst failure is a false
  NUDGE — the message is held pre-send until the agent acknowledges or
  revises (a `422 tone-gate-advisory`, structurally distinct from a terminal
  `tone-gate-blocked`), surfaced immediately in the decision log.
- Change B: remove the source + provider (one commit). The registry file is
  inert data; leaving it in place has no effect once the probe is gone. The
  CLAUDE.md sentence is prose; the migration is content-sniffed and would
  simply stop matching.
