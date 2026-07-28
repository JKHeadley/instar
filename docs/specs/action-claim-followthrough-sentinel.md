---
status: approved
approved: true
approval-provenance: "Justin 2026-06-15, topic 12476: 'whenever you claim to be doing an action of any type, we should have sentinels in place that detect that and then track if that action was actually followed through' — the original impetus behind commitment tracking; it failed to catch my 'relaunching now' that then didn't happen."
parent-principle: "Close the Loop"
lessons-engaged:
  - "Close the Loop (a claimed future action is an opened loop that must reach a deliberate close)"
  - "Signal vs. Authority (detect + register/advise; never block the send)"
  - "Bounded Notification Surface (high-precision trigger + expiry + per-topic cap so commitments never spam)"
  - "An Autonomous Run Must Outlive Its Session (A1 commitments ride the PromiseBeacon-escalation/ResumeQueue revival path; a disabled follow-through engine is guard-posture-visible, never silent)"
  - "Distrust Temporary Success / conservative extraction (A1 fails toward NOT registering)"
review-convergence: "2026-06-15T18:55:55.863Z"
review-iterations: 2
review-completed-at: "2026-06-15T18:55:55.863Z"
review-report: "docs/specs/reports/action-claim-followthrough-sentinel-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "codex-not-on-path-in-context"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# Action-Claim Follow-Through Sentinel (P2)

## The gap

When I send an outbound message that CLAIMS a concrete future action ("relaunching
now", "I'll fix X", "pushing the change"), nothing durably ensures the action
happens. On 2026-06-15 I told the operator "Relaunching now" and then ended the
turn without relaunching. This is the word≠action / "narrating intentions as
completed actions" failure mode — and per the operator it is the original reason
commitment-tracking exists. (The Cross-Agent Communication Discipline in CLAUDE.md
is a SIBLING of this — same root, but scoped to A2A messages; this sentinel covers
user-facing conversational turns.)

## The existing foundation (build ON, don't duplicate or re-invent)

- **`src/monitoring/CommitmentTracker.ts` — `detectTimePromise()` + `record()`
  ALREADY sniff `agentResponse`** for future-action/time promises ("I'll check in",
  "report back", "in N min") and auto-enable a PromiseBeacon. A1 MUST extend THIS
  path, not run a second drifting classifier. **[verified by lessons reviewer:
  CommitmentTracker.ts ~462-471, 765-813.]**
- **DEDUPE DOES NOT EXIST (the load-bearing gap).** `record()` mints a fresh
  `CMT-NNN` on every call; `externalKey` is stored but NEVER read for idempotency.
  So a naive "register on every future-action phrase" spawns N commitments. FD3
  builds the missing idempotency.
- **`src/core/time-claim.ts`** — the deterministic-regex precedent (pure, total,
  fail-open, first-person scoped, quote-skipping). A1's classifier mirrors its
  *shape* (NOT its fail direction — see FD2).
- **`.instar/hooks/instar/response-review.js`** — the PROVEN Stop-hook siting:
  reads `input.last_assistant_message` + `INSTAR_TELEGRAM_TOPIC`, POSTs to a server
  route. A1 rides this conversational path (OutboundAdvisory only sees AUTOMATED
  sends, so it can NOT catch the conversational incident).
- **PromiseBeacon escalation + ResumeQueue revival** (shipped) — an A1 commitment
  whose session dies is escalated/revived, and a disabled follow-through engine is
  guard-posture-visible (the "outlive its session" standard) — so A1 never silently
  drops a promise.

## Scope decision: A1 (future-action) is the v1 feature; A2 (completed-action) is descoped

- **A1 — future-action claims → durable follow-through commitment.** This is the
  v1 feature and it catches the founding incident.
- **A2 — completed-action claims ("relaunched", "pushed") verified against
  evidence — DESCOPED from v1**, because the evidence channel does not exist:
  `OutboundAdvisory` is a PURE text function with NO access to the turn's tool-call
  trace or git/fs state, and the Stop-hook input carries only `last_assistant_message`.
  The TIME_CLAIM precedent only works because the clock is caller-INJECTED; there is
  no equivalent injected "did this action happen" value. Shipping A2 on that false
  analogy would lean on a primitive that doesn't exist (the exact P1 lesson). A2 is a
  TRACKED follow-up that must first scope a real per-turn evidence primitive (the
  tool-call trace → a checkable signal). <!-- tracked: CMT-1554-action-claim-A2-evidence-primitive --> Not avoidance: A2 is genuinely
  unbuildable today; the founding incident was a FUTURE-action claim, which A1 covers.

## Frontloaded Decisions

- **FD1 — Siting: conversational Stop-hook (A1), not advisory-only.** Grounded:
  OutboundAdvisory only runs for scheduler-stamped automated sends; the incident was
  a conversational reply. A1 rides a Stop hook on `last_assistant_message` +
  `topicId` (the `response-review.js` precedent).
- **FD2 — A1 is HIGH-PRECISION and fails toward NOT registering.** Unlike TIME_CLAIM
  (where a missed claim is the safe under-block), an A1 false-positive is a durable
  NAGGING commitment (a known scarring class). So A1 triggers ONLY on a closed set of
  CONCRETE, checkable first-person action verbs — `relaunch|restart|redeploy|deploy|
  push|merge|revert|rebase|fix <obj>|rerun|re-run` — in first-person near-future or
  present-progressive ("I'll restart", "restarting now", "pushing it"). Bare "I'll" /
  "now" / vague "look into"/"keep in mind" do NOT trigger. On ANY ambiguity: do NOT
  register (precision over recall). Deterministic regex, quote-skipping, first-person
  scoped (time-claim.ts shape).
- **FD3 — Dedupe + auto-expiry (builds the missing idempotency).** Every A1
  commitment carries `externalKey = sha256(topicId + '|' + normalizedClaimVerb)` and
  a short `expiresAt` (default 6h, configurable). `record()` (or a thin
  `/commitments` idempotent-create path) is extended to: on an OPEN commitment with
  the same `externalKey`, RETURN-existing (no new row) instead of minting a duplicate.
  So restating "I'll restart" across turns updates one commitment; a mis-fire expires
  quietly rather than nagging forever. A per-topic concurrent-A1-commitment cap
  (default 5) bounds the surface (Bounded Notification Surface). This idempotency is
  net-new durable-state logic on the CAS-guarded store — implemented behind the dark
  flag, with its own unit coverage.
- **FD4 — Present-progressive tense rule.** "X-ing now" / "relaunching now" (the
  literal founding phrase) is classified as A1 (future/in-flight) → register a
  follow-through. A claim in clear past tense ("relaunched", "pushed") is NOT A1 (it
  is the descoped A2 class) → do nothing in v1. The disambiguation is part of the
  deterministic classifier truth-table.
- **FD5 — Signal-only, dark + dev-first.** One flag `messaging.actionClaim.enabled`
  (code-defaulted off on the fleet; resolves on via the dev-agent gate). The Stop
  hook is a pure side-effect POST that ALWAYS `exit(0)` — never `decision:block`
  (signal-only; the message always sends). The catch is the durable commitment, not a
  gate.
- **FD6 — Migration Parity.** A1 ships as a SIBLING Stop hook in the `instar/`
  hooks dir (always-overwritten on migration) + a `migrateSettings()` entry that
  registers it in existing agents' `.claude/settings.json` Stop array, and a
  `migrateConfig()` existence-check for the flag default. Without this the feature
  would only reach new agents (a broken feature per the Migration Parity Standard).

## Design

A new `instar/` Stop hook (`action-claim-followthrough.js`) reads
`last_assistant_message` + `INSTAR_TELEGRAM_TOPIC`, runs the FD2 deterministic
classifier, and on a positive A1 match POSTs to an idempotent commitment-create
(FD3) bound to the topic with `type:'one-time-action'`, `externalKey`, `expiresAt`.
The existing PromiseBeacon then drives follow-through; the existing commitment-check
job surfaces overdue ones; the "outlive its session" revival path covers session
death. Pure side-effect, `exit(0)` always.

## Tests (all three tiers)
- Unit: the FD2 classifier truth-table — concrete action verb + first-person +
  near-future/present-progressive → A1; bare "I'll"/"now"/vague → none; past tense →
  none (A2 descoped); quote-skipping; the present-progressive "relaunching now" →
  A1 case (founding incident). FD3: same `externalKey` → returns existing (no
  duplicate); distinct claim → new; expiry; per-topic cap.
- Integration: a future-action claim registers exactly ONE commitment; a restated
  claim does NOT create a second; a benign message registers none; the hook always
  exits 0 (never blocks).
- E2E: the "feature is alive" path — with the flag on, a conversational turn
  claiming a concrete action results in an open commitment for the topic
  (`GET /commitments`), and the PromiseBeacon picks it up.

## Open questions
*(none)*
