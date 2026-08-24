# W25 Lane 3 - Blocker B-2 Hook Population Measurement

## Scope And Constraints

Worker: Codey lane 3, reporting to Echo/Pathway topic 29723.

Charter read: `sed -n '1,240p' .instar/w25/CHARTER.md` on `DaBombs-Mac-Studio.local` at `2026-08-23T21:41:40Z`. Salient result: Window 25 is active; B-2 requires exact guard-population verification of hook registrations actually loaded in every running session. This lane is measurement only.

Deliberately not done: no push, no merge, no PR, no deploy, no server restart, no session restart/refresh/nudge/kill, no edit to `.claude/settings.json`, and no application of `.instar/w24/recovery/settings.RESTORED.json`.

Write exception: this report is the only intentional write in the live agent tree because the brief names `/Users/dabombstudio/.instar/agents/echo/.instar/w25/lane-3-blocker-b2.md` as the required artifact path.

## Measurement Controls

Control for the session census: `GET /sessions` can show a changed population because it returns concrete session records with ids, names, status, tmux session names, framework, and `startedAt`. Cross-check: `tmux list-sessions` can show tmux sessions missing from the API or extra non-agent sessions.

Control for on-disk hook count: parsing `.claude/settings.json` counts `hooks[*][*].hooks.length`; this would have shown 19 if the restored file had not been present and 36 if it was. This proves only file content, not loaded process state.

Control needed for loaded hook count: a per-process loaded-settings snapshot, startup debug log, or a hook event that identifies the process's loaded hook table independently of the current `.claude/settings.json`. Until such a control is found for a session, loaded count is `unmeasured`, not zero and not matching disk.

## Machine Evidence

Machine/time command: `hostname && date -u +%Y-%m-%dT%H:%M:%SZ && pwd`

Output at `2026-08-23T21:41:40Z`:

```text
DaBombs-Mac-Studio.local
2026-08-23T21:41:40Z
/Users/dabombstudio/.instar/agents/echo
```

## On-Disk Hook Counts

Command at `2026-08-23T21:41:51Z`:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ; node -e "const fs=require('fs'); const p='.claude/settings.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); const hooks=j.hooks||{}; let c=0; for (const arr of Object.values(hooks)) for (const e of arr||[]) c+=(e.hooks||[]).length; console.log(JSON.stringify({path:p, hookEvents:Object.keys(hooks), hookRegistrations:c},null,2));"
```

Output excerpt:

```json
{
  "path": ".claude/settings.json",
  "hookEvents": [
    "PreToolUse",
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "WorktreeCreate",
    "WorktreeRemove",
    "TaskCompleted",
    "SessionEnd",
    "PreCompact",
    "PermissionRequest"
  ],
  "hookRegistrations": 36
}
```

Verdict, on-disk `exists`: `true` - measured on `DaBombs-Mac-Studio.local` at `2026-08-23T21:41:51Z`; current `.claude/settings.json` contains 36 hook registrations.

Framework split command at `2026-08-23T21:43:25Z`:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ; node -e "const fs=require('fs'); for (const p of ['.claude/settings.json','.codex/hooks.json']) { const j=JSON.parse(fs.readFileSync(p,'utf8')); const hooks=j.hooks||{}; let c=0; const events={}; for (const [k,arr] of Object.entries(hooks)) { let n=0; for (const e of arr||[]) n+=(e.hooks||[]).length; events[k]=n; c+=n; } console.log(JSON.stringify({path:p,total:c,events},null,2)); }"
```

Output excerpt:

```json
{ "path": ".claude/settings.json", "total": 36, "events": { "PreToolUse": 13, "SessionStart": 3, "UserPromptSubmit": 2, "PostToolUse": 4, "SubagentStart": 1, "SubagentStop": 1, "Stop": 6, "WorktreeCreate": 1, "WorktreeRemove": 1, "TaskCompleted": 1, "SessionEnd": 1, "PreCompact": 1, "PermissionRequest": 1 } }
{ "path": ".codex/hooks.json", "total": 14, "events": { "PreToolUse": 5, "PermissionRequest": 1, "Stop": 5, "PostToolUse": 1, "SessionStart": 1, "UserPromptSubmit": 1 } }
```

Backup/control command at `2026-08-23T21:43:51Z`:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ; node -e "const fs=require('fs'); for (const p of ['.claude/settings.json.bak-pre-guard-restore-20260823T185138Z','.claude/settings.json.bak-pre-stophook-20260823T132801Z']) { const j=JSON.parse(fs.readFileSync(p,'utf8')); let c=0; const events={}; for (const [k,arr] of Object.entries(j.hooks||{})) { let n=0; for (const e of arr||[]) n+=(e.hooks||[]).length; events[k]=n; c+=n; } console.log(JSON.stringify({path:p,total:c,events},null,2)); }"
```

Output excerpt:

```json
{ "path": ".claude/settings.json.bak-pre-guard-restore-20260823T185138Z", "total": 19 }
{ "path": ".claude/settings.json.bak-pre-stophook-20260823T132801Z", "total": 18 }
```

This is the control that proves the count operation could have shown the older lower populations.

UTC mtime command at `2026-08-23T21:44:11Z`:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ; for p in .claude/settings.json .codex/hooks.json .claude/settings.json.bak-pre-guard-restore-20260823T185138Z .claude/settings.json.bak-pre-stophook-20260823T132801Z; do e=$(stat -f %m "$p"); printf '%s ' "$p"; date -u -r "$e" +%Y-%m-%dT%H:%M:%SZ; done
```

Output:

```text
.claude/settings.json 2026-08-23T20:05:54Z
.codex/hooks.json 2026-08-23T20:05:54Z
.claude/settings.json.bak-pre-guard-restore-20260823T185138Z 2026-08-23T18:51:38Z
.claude/settings.json.bak-pre-stophook-20260823T132801Z 2026-08-23T13:28:01Z
```

Correction note: an earlier local `stat -f '%Sm' ... -t '%Y-%m-%dT%H:%M:%SZ'` command printed local PDT clock values with a literal `Z`. I did not use that as final evidence; the epoch-to-UTC command above is the corrected timestamp measurement.

## Running Session Census

Command at `2026-08-23T21:41:51Z`:

```bash
AUTH=$(node .instar/scripts/secret-get.mjs authToken); date -u +%Y-%m-%dT%H:%M:%SZ; curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/sessions
```

Salient output: 9 running agent sessions.

Cross-check command at `2026-08-23T21:42:20Z`:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ; tmux list-sessions -F '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}'
```

Salient output: the same 9 agent tmux sessions plus `echo-server`, with all listed as unattached and one-window sessions.

## Per-Session Hook Population

Loaded-count measurement attempts:

- `GET /sessions` at `2026-08-23T21:44:46Z` returned provider ids for all active sessions but no telemetry summaries.
- `GET /hooks/events/<provider-id>/summary` at `2026-08-23T21:44:46Z` returned `{"error":"No events found for session"}` / HTTP 404 for sampled active provider ids: the three W25 Codex ids, Observer 2's Codex id, and four Claude ids. This proves the current hook-event endpoint is not keyed in a way that gives loaded hook counts for active sessions.
- `GET /hooks/sessions` at `2026-08-23T21:44:32Z` returned historical hook-event session ids with event counts, for example `{"sessionId":"ff4dfb0b-6c8a-4601-af88-01f94fcfce22","eventCount":1}`. It does not include hook registration counts or a mapping to the active `/sessions` records.
- `tmux capture-pane` at `2026-08-23T21:44:11Z` was read-only and did not disturb sessions. It showed partial hook activity in some panes, including `echo-observer` showing `running stop hooks... 5/6`, and `echo-grok-cursor` showing `PreCompact [node .instar/hooks/instar/hook-event-reporter.js] completed successfully`. This proves some loaded hooks in those sessions, but not the full registration population.
- `ps -p ... -o ...` at `2026-08-23T21:43:51Z` failed with `zsh:1: operation not permitted: ps`, so process command-line/open-file inspection was unavailable on this machine.

Verdict for loaded full registration counts: `unmeasured` for every running session. Reason: no read-only surface available in this lane returned the loaded hook table or loaded registration count for already-running processes, and provoking every event in every process would disturb live work.

| Session | Framework | Started At | tmux Session | Relevant On-Disk Count | Loaded Count | Outcome | Measurement / Reason |
|---|---:|---:|---|---:|---:|---|---|
| `w25-lane-1-integration` | `codex-cli` | `2026-08-23T21:41:24.322Z` | `echo-w25-lane-1-integration` | 14 (`.codex/hooks.json`) | unmeasured | `unmeasured` | `/sessions` at `2026-08-23T21:41:51Z`; Codex SessionStart output exists at `/var/.../hook_outputs/01a03092-3914-.../ee53392f-...txt`, but it does not include loaded hook count. |
| `w25-lane-3-blocker-b2` | `codex-cli` | `2026-08-23T21:41:24.901Z` | `echo-w25-lane-3-blocker-b2` | 14 (`.codex/hooks.json`) | unmeasured | `unmeasured` | `/sessions` at `2026-08-23T21:41:51Z`; Codex SessionStart output exists at `/var/.../hook_outputs/01a03092-3b50-.../ed4efd95-...txt`, but it does not include loaded hook count. |
| `Cross-machine conversation coherence` | `claude-code` | `2026-08-23T18:27:19.829Z` | `echo-cross-machine-conversation-coherence` | 36 (`.claude/settings.json`) | unmeasured | `unmeasured` | Started before the 18:51:38Z 19-to-36 restore; no loaded-settings snapshot found. |
| `Grok/Cursor` | `claude-code` | `2026-08-23T20:55:57.608Z` | `echo-grok-cursor` | 36 (`.claude/settings.json`) | unmeasured | `unmeasured` | Pane showed a completed `PreCompact` hook at `2026-08-23T21:44:11Z`, proving some hook loading but not full count. |
| `Multi-machine placement & load measurement` | `claude-code` | `2026-08-23T05:52:55.722Z` | `echo-multi-machine-placement-load-measurement` | 36 (`.claude/settings.json`) | unmeasured | `unmeasured` | Started before the 13:28:01Z 18-count backup and before the 18:51:38Z restore; no loaded-settings snapshot found. |
| `w25-lane-2-blocker-b1` | `codex-cli` | `2026-08-23T21:41:24.590Z` | `echo-w25-lane-2-blocker-b1` | 14 (`.codex/hooks.json`) | unmeasured | `unmeasured` | `/sessions` at `2026-08-23T21:41:51Z`; Codex SessionStart output exists at `/var/.../hook_outputs/01a03092-3a19-.../7775d2f9-...txt`, but it does not include loaded hook count. |
| `2 Observer 2 (GPT-5.6-Sol)` | `codex-cli` | `2026-08-22T20:51:50.726Z` | `echo-2-observer-2-gpt-5-6-sol` | 14 (`.codex/hooks.json`) | unmeasured | `unmeasured` | Pane showed `UserPromptSubmit hook`, `Stop hook`, and `PreToolUse hook` activity at `2026-08-23T21:44:11Z`, proving some hooks loaded but not count. |
| `observer` | `claude-code` | `2026-08-23T20:10:45.863Z` | `echo-observer` | 36 (`.claude/settings.json`) | unmeasured | `unmeasured` | Pane showed `running stop hooks... 5/6` at `2026-08-23T21:44:11Z`, proving 6 Stop hooks loaded but not full 36. |
| `LLM Pathway Characterization` | `claude-code` | `2026-08-23T19:32:35.913Z` | `echo-llm-pathway-characterization` | 36 (`.claude/settings.json`) | unmeasured | `unmeasured` | Started after the 18:51:38Z restore but before the 20:05:54Z rewrite; no loaded-settings snapshot found. |
| `Deepseek harness` | `claude-code` | `2026-08-23T21:14:39.733Z` | `echo-deepseek-harness` | 36 (`.claude/settings.json`) | unmeasured | `unmeasured` | Started after the 20:05:54Z rewrite; no loaded-settings snapshot found. |

## Guard Posture Surface

Command at `2026-08-23T21:41:51Z`:

```bash
AUTH=$(node .instar/scripts/secret-get.mjs authToken); date -u +%Y-%m-%dT%H:%M:%SZ; curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/guards
```

Output excerpt:

```json
{
  "machineId": "m_03b30f5b32c6ef3eb0afd3ca7054e252",
  "nickname": "Mac Studio",
  "version": "1.3.1193",
  "generatedAt": "2026-08-23T21:41:51.830Z",
  "summary": {
    "onConfirmed": 20,
    "onUnverified": 43,
    "onDryRun": 12,
    "off": 17,
    "divergedPendingRestart": 0,
    "missing": 0,
    "runtimeEnriched": "27/92"
  }
}
```

Posture verdict: `/guards` is a server guard posture surface, not a per-session loaded hook table. It says `divergedPendingRestart: 0` and `missing: 0`, but this does not agree or disagree with loaded session hook counts because those counts are not exposed. The posture surface is therefore `unmeasured` for B-2's exact loaded-hook question.

## Does The 36 Claim Hold?

On disk for Claude: `true`. `.claude/settings.json` measured 36 registrations at `2026-08-23T21:41:51Z`, and the 19-count backup measured at `2026-08-23T21:43:51Z` proves the counting control could have shown the earlier lower state.

On disk for Codex: `false` if the claim is applied literally to Codex workers. `.codex/hooks.json` measured 14 registrations at `2026-08-23T21:43:25Z`.

Loaded inside running sessions: `unmeasured`. I cannot corroborate that any session carries a full loaded count of 36. I also cannot prove a lower full loaded count. The only process-loaded measurements found were partial event-level proofs: `observer` has 6 Stop hooks loaded, `Grok/Cursor` fired a PreCompact hook, and Observer 2 displayed UserPromptSubmit/Stop/PreToolUse hook activity. Those are not full-population counts.

Release implication: B-2 is not satisfied as an `effective` proof of every running session's loaded hook registrations. The safest statement is that the machine currently *looks* restored on disk for Claude, but the live per-session loaded population remains unmeasured with the current read-only instrumentation.
