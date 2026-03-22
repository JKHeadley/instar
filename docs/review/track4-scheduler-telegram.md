# Track 4: Scheduler, Jobs & Telegram

## Executive Summary
Scheduler uses the `croner` library (not node-cron) with priority-driven quota throttling. Telegram integration is built on raw HTTP to the Bot API (no library dependency). Jobs map 1:1 to Telegram topics with configurable notification modes. Runtime pause/resume is memory-only (resets on restart). No filesystem-event triggers — cron only.

---

## 1. Cron Implementation

**[VERIFIED]** `src/scheduler/JobScheduler.ts:11`
```typescript
import { Cron } from 'croner';
```
- **Library**: `croner` v8.0.0 — NOT node-cron or node-schedule
- **Accuracy**: Millisecond precision via `nextExecution()` calls
- **Storage**: `Map<string, Cron>` (line 62) — one Cron instance per job

---

## 2. Job Pause/Resume

**[VERIFIED]** `src/scheduler/JobScheduler.ts`

```typescript
pause(): void { this.paused = true; }                    // line 380-382
resume(): void { this.paused = false; this.processQueue(); } // line 387-390
```

- Private field `paused: boolean` (line 65)
- Trigger check (line 266-268): if paused, records skip with reason 'paused'
- Exported in `getStatus()` (line 399): `SchedulerStatus.paused: boolean`
- **Memory-only** — resets on server restart, no persistence

---

## 3. Quota Tracking

**[VERIFIED]** `src/monitoring/QuotaTracker.ts`

**Measurement** (lines 110-118): Reads from `quota-state.json`:
- Weekly usage percentage (0-100)
- 5-hour rate limit percentage
- Optional `recommendation` field

**Throttle strategy** (priority-based, NOT hard-stop):

| Condition | Action |
|-----------|--------|
| 5-hour >= 95% | Block ALL spawns |
| 5-hour >= 80% | Critical priority only |
| Weekly >= shutdown (95%) | No jobs |
| Weekly >= critical (80%) | Critical only |
| Weekly >= elevated (60%) | High+ priority only |
| Weekly >= normal (50%) | Medium+ priority only |

- Return type: `{ allowed: boolean; reason: string }` (line 105)
- Remote integration: `fetchRemoteQuota()` polls external quota authority with Bearer token
- **Fail-open**: Missing quota data → allow all jobs

---

## 4. Job Output Routing

**[VERIFIED]** `src/scheduler/JobScheduler.ts:120-134`

- **Primary channel**: Telegram topics (job-topic coupling)
- `telegramNotify` field (types.ts:87):
  - `true` — always notify
  - `false` — never notify (no topic)
  - `'on-alert'` — only on failure or `[ATTENTION]` in output (default)
- **No webhooks or custom handlers** for job output
- **Fallback**: No Telegram → local state file only

---

## 5. Default Jobs

**[VERIFIED]** Job definitions live in `.instar/jobs.json` (created at init), NOT hardcoded.

**JobDefinition fields** (types.ts:55-103):
- `slug`, `schedule` (cron), `priority`, `model` ('opus'|'sonnet'|'haiku')
- `execute`: `{ type: 'skill'|'prompt'|'script', value: string }`
- `supervision`: 'tier0'|'tier1'|'tier2'
- `gate`: Optional pre-flight shell command (zero-token check)
- `livingSkills`: Optional execution journaling config

**No built-in token cost tracking** — depends on model + session duration.

---

## 6. Filesystem Watching

**[VERIFIED]** CRON-ONLY — no `fs.watch` integration.

Pre-flight gate (types.ts:76) allows a shell command check before spawn (e.g., curl to check for updates), but this is not filesystem watching.

---

## 7. Telegram Bot Implementation

**[VERIFIED]** `src/messaging/TelegramAdapter.ts`

- **Library**: NONE — raw HTTP to `https://api.telegram.org/bot{token}/{method}`
- Native `fetch()` for API calls (line 260)
- JSON POST requests via `callMethod()` (line 6-9)
- **Long-polling** for updates

---

## 8. Topic Management

**[VERIFIED]** `src/messaging/TelegramAdapter.ts`

- **Mapping**: Job → Telegram topic (stored in state)
- **Session coupling**: Each session linked to topic via `INSTAR_TELEGRAM_TOPIC` env var
- **General topic**: Topic ID <= 1 is "General" (line 160), no `message_thread_id` in outgoing
- **Auto-creation**: Job topics created lazily or on scheduler start (lines 940-975)
- **Topic emoji**: Keyword-based emoji assignment (lines 203-226)

---

## 9. Proactive Messaging

**[VERIFIED]** YES — full bidirectional capability.

Trigger points:
- Job completion notifications (via scheduler)
- Alert/attention items (via `/attention` endpoint)
- LLM reflection completion messages
- System notifications (updates, quota alerts)

Messages sent directly via bot API — no user intervention needed.

---

## 10. Media Handling

**[VERIFIED]** `src/messaging/TelegramAdapter.ts`

| Media Type | Support | Lines |
|------------|---------|-------|
| Photos | `photo` field in TelegramUpdate | 97-103 |
| Voice | `voice` field with transcription | 90-96 |
| Documents | `document` field | 105-111 |

- **Transcription providers**: 'groq' or 'openai' (auto-detected if not set)
- **To CC session**: Media passed via attachment envs or described in text context
- **Return to user**: File IDs stored, can be re-sent or linked
