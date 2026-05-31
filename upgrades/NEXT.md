<!-- bump: minor -->

# Correction & Preference Learning Sentinel — Slice 1b (the sentinel loop)

## What Changed

Slice 1b of the Correction & Preference Learning Sentinel ships the loop that turns the moments a user has to correct the agent into durable, structurally-applied learning. It builds on the Slice-1a preferences read-surface and is **SIGNAL-ONLY** — it never blocks or rewrites an outbound message. It ships **dark** behind `monitoring.correctionLearning.enabled` (default false); only the free, metadata-only Layer-0 classification is always-on.

- **Layer-0 extension** (`src/monitoring/HumanAsDetectorLog.ts`): two distinctly-tagged signal families — `preference` ("from now on", "I'd rather", "keep it") and `frustration` ("you keep …ing", "every time", "stop asking me"). They are **excluded from `summarizeByLayer()`** so the guardian-failure heat map's precision contract is untouched. `classify()` now exposes `deterministicWeight` + `learningKind`. A drift-canary counter records regex-recall misses.
- **Shared `scrubSecrets`** (`src/monitoring/scrubSecrets.ts`): extracted from `CiFailurePoller` with extended coverage (Telegram bot tokens, AWS access keys, Slack tokens, URLs with embedded credentials). Applied PRE-scrub before the distill prompt egresses and POST-scrub before persist.
- **`CorrectionLedger`** (`src/monitoring/CorrectionLedger.ts`): SQLite at `<stateDir>/correction-ledger.db`. Dedupe-upsert on `kind:normalizedLearningHash` (SHA-256 over a canonical normalized form — hash stability is a unit-tested invariant), bounded `correction_occurrences` (prune-in-transaction, cap 200), distinct-days/topics with a deterministic-weight provenance filter, `toApiView()` strips raw `learning`, `countRecords()` health metric.
- **`CorrectionAnalyzer`** (`src/monitoring/CorrectionAnalyzer.ts`): the 3-pronged restart-proof recurrence gate (`minSupport` AND distinct calendar days AND a second orthogonal prong — distinct topics for preferences / cross-agent Rising Tide downstream for infra-gaps). `llm_confidence` is advisory and never alone admits a record.
- **`CorrectionLoopDriver`** (`src/monitoring/CorrectionLoopDriver.ts`): the by-construction authority-bounded router. Its `LoopDeps` carry only `addAction`, `createInitiative`, `feedbackLoopbackPost`, `recordPreference`, `attentionRoute` — no proposal-minting, no direct memory-file write. Explicit preference → `recordPreference()`; policy-relaxation phrasing → Attention (human disposes, never silently applied); infra-gap → tracked Action + draft Initiative (or loopback `/feedback` when `autoFeedback` is on). Closed-loop verify keyed on `dedupeKey`; silence alone is never treated as effective.
- **`CorrectionCaptureLoop`** (`src/monitoring/CorrectionCaptureLoop.ts`): the hot-path capture → distill → ledger hop, wired VOID fire-and-forget into the inbound message chain so it can never block delivery or propagate an error. Per-topic LRU/TTL-evicted ring (never serialized into `/health`); prompt-injection-hardened distillation; all three `LlmQueue` throw paths caught → silent drop.
- **Routes** (`src/server/routes.ts`): `GET /corrections`, `GET /corrections/:id`, `POST /corrections` (requires `X-Instar-Request: 1`), `POST /corrections/analyze` (the recurrence gate + closed-loop tick). 503 when disabled. Plus the `correction-analyzer` weekly Tier-1 cron job template (off by default).
- Boot wiring in `src/server/AgentServer.ts` + `src/commands/server.ts`; `CapabilityIndex` entry; CLAUDE.md template + migration backfill.

## What to Tell Your User

I now learn from the moments you have to correct me, instead of letting each lesson evaporate when the session ends. When you correct me the same way across several days — plainer language, no tables in chat, lead with the one action, stop asking the same question every session — I quietly distil the recurring lesson and either save it as a preference I will carry forward on every future session, or, if it points at a gap in the tool itself, queue a proposal for a human to review. I only act on a lesson once it has genuinely recurred across distinct days, never on a one-off.

This is watching-only. It never blocks, rewrites, or delays anything I send you. It is turned off by default and turns on only when you ask. Your raw words are never stored — only a short, secret-scrubbed summary plus counts. And I will never quietly relax a safety or confirmation step on my own: if a learned preference looks like it would loosen a guard, I route it to you for a one-tap approval rather than applying it myself.

You can ask me what I have learned about you, and I will show you the saved preferences and the patterns I have noticed.

## Summary of New Capabilities

- `GET /corrections` — list distilled, scrubbed correction/preference records (keyset pagination via `?before`/`?limit`/`?kind`/`?status`; raw learning text is never served).
- `GET /corrections/:id` — one record (scrubbed summary + metadata only).
- `POST /corrections` — agent-diagnosed one-tap record (requires `X-Instar-Request: 1`).
- `POST /corrections/analyze` — runs the 3-pronged recurrence gate + the closed-loop routing/verify tick (driven by the off-by-default `correction-analyzer` weekly job).
- All routes 503 when `monitoring.correctionLearning.enabled` is false (the default).

## Evidence

- **Build**: `npm run build` green (tsc + manifest regen + lockfile sign).
- **Lint**: `npm run lint` green.
- **Unit** (5 files, classifier/ledger/analyzer/router/capture): both-sides classification + lone-weak-never + `summarizeByLayer()` unchanged + drift canary; ledger dedupe/prune/distinct-days/hash-stability/toApiView; analyzer 3-pronged below-vs-at + provenance filter + llm-confidence-alone-never; routing split + policy-keyword→Attention + by-construction authority + silence≠effective; capture both-sided scrub + prompt-injection-not-followed + over-apology + all-three-LlmQueue-throws.
- **Wiring-integrity** (`tests/unit/correction-learning-wiring-integrity.test.ts`): ledger constructed iff enabled (200/503 + db-created on the production AgentServer boot path); LoopDeps surface is exactly the five bounded deps; `captureAndDistill` resolves and never throws into the delivery seam; loopback `/feedback` refuses (returns false) without crashing or double-routing.
- **Integration** (`tests/integration/corrections-routes.test.ts`): 401 without bearer; 503 when disabled; `X-Instar-Request` required on POST; `toApiView` strips raw learning + sessionId; pagination; `/health` never serializes the capture ring.
- **E2E** (`tests/e2e/correction-learning-lifecycle.test.ts`): feature-alive 200/503 on the production boot path; the §8 acceptance fixtures — a recurring explicit preference written to `.instar/preferences.json` with `provenance: correction-loop`, and the force-push nag routed as an infra-gap; raw learning never served.
- **Parity guards** green: `feature-delivery-completeness`, `capabilities-discoverability`, `builtin-manifest`, `ConfigDefaults`.
