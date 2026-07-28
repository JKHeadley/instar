# Side-effects review — Approval-as-Data ledger (Phase 2)

Spec: `docs/specs/AUTONOMOUS-OPERATION-JUDGMENT-AND-APPROVAL-AS-DATA-SPEC.md` (Part B).
Change: new `src/core/ApprovalLedger.ts` + `POST/GET /approvals`, `GET /approvals/summary`
wired through `AgentServer` → `RouteContext`; Agent-Awareness blurb in the CLAUDE.md template.

## 1. Blast radius
Additive only. A new module, three new route handlers, one new always-constructed field
on `AgentServer`, one new `RouteContext` field, one template blurb. No existing route,
store, sentinel, or gate is modified. The ledger never gates, blocks, throttles, or
mutates any other state — read paths are pure reads; the one write path appends to its
own JSONL file.

## 2. State / data
New on-disk file `.instar/state/approval-ledger.jsonl` (append-only, signed). No schema
migration — the file is created on first write and absent until then. No existing file is
touched. Torn-trailing-line tolerant on read. Rows are HMAC-signed over `authToken`; an
empty/missing file yields an empty summary (no crash).

## 3. Interactions
- `RouteContext` gains a REQUIRED `approvalLedger` field. The only production assembler is
  `AgentServer` (updated). Route tests build `ctx: any` partials, so they are unaffected
  (tsc confirms the whole tree compiles).
- Construction rides the existing `stateDir` availability (like `tokenLedger`); own
  try/catch so an init failure can never cascade into the other ledgers.
- Shares no lock, queue, or budget with any other component.

## 4. Failure modes
- No `authToken` → falls back to a fixed dev key for signing (integrity-only; documented).
  Signing is never load-bearing for correctness — the operator-authoritative-source rule is.
- `stateDir` absent → `approvalLedger` is null → routes 503 (handled + tested).
- Inconsistent row (as-is WITH a divergence, or a change WITHOUT one) → `recordApproval`
  throws → the route returns 400, not 500 (tested). Bad data cannot pollute ratios.
- Disk-full / write error on append → throws to the caller (route 400/500); no partial
  corrupt state (single `appendFileSync`).

## 5. Security / authority
- The load-bearing invariant is **operator-authoritative `mode` + `divergences`**: the
  agent must not self-classify intent. Enforced by documentation + the design (the route
  records what the caller passes; the caller must pass an explicit operator statement) and
  backstopped by operator-correctable rows. HMAC signing gives integrity, NOT correctness —
  it stops tampering, not ratio inflation; the authority rule stops inflation.
- All routes are Bearer-gated (standard middleware). Read routes never gate behavior.

## 6. Performance
- O(rows) summary computation over a small append-only file read on each summary call.
  At realistic volumes (tens to low-hundreds of approvals) this is negligible. No polling,
  no background work, no LLM calls. Phase-3 (auto-approval, digest) is out of scope here.

## 7. Migration parity
- No `.claude/settings.json` hook, `.instar/config.json` default, or hook-script change →
  no `PostUpdateMigrator` entry required. The feature is server-side code that activates on
  the next server start after update; existing agents get it by updating, with no on-disk
  migration. Agent-Awareness IS satisfied: the CLAUDE.md template gained an Approval-as-Data
  blurb (`generateClaudeMd`).
- Always-on when `stateDir` exists (read-only, low-cost) — no enable flag to migrate.

## Tests
- Unit (`tests/unit/ApprovalLedger.test.ts`, 18): record/read/verify, tamper-reject, every
  consistency-guard throw + its passing counterpart, ratio + streak (reset on change/reject),
  auto-eligibility threshold edges, surface generality, corrections, torn-line tolerance.
- Integration (`tests/integration/approvals-routes.test.ts`, 6): full HTTP round-trip over a
  real ledger; summary + surface breakdown; the 400 + 503 paths.
- E2E (`tests/e2e/approval-ledger-lifecycle.test.ts`, 5): real AgentServer boot, alive
  (200 not 503), record→summary→list lifecycle, Bearer-gate, and a WIRING-INTEGRITY proof
  that the production HMAC signer is real (persisted row verifies; a tamper fails).

## Post-review amendments (same PR, pre-merge)

- **State-path fix:** the ledger file follows the `.instar/state/` convention —
  `config.stateDir` IS `.instar`, durable state lives under `state/`
  (`.instar/state/approval-ledger.jsonl`, matching the spec's stated path). The e2e
  wiring-integrity test proves the corrected path end-to-end.
- **Ratchet exemptions:** the three deny-safe/default-empty catches carry
  `@silent-fallback-ok` markers INSIDE the catch blocks (missing-file → empty
  history; malformed signature → verifies false; init failure → reported via
  console.warn + ledger null → routes 503).
- **Docs coverage:** the three `/approvals` routes are documented in
  `site/src/content/docs/reference/api.md` (route-floor gate).
- **Discoverability:** the `/approvals` prefix is classified in
  `CapabilityIndex.ts` (CAPABILITY_INDEX → surfaced in `/capabilities` with its
  three endpoints), satisfying the capabilities-discoverability gate.
