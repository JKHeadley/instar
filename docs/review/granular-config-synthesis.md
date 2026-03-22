# Granular Feature Configuration — Synthesis

---

## Question 1: Is this exact configuration achievable without forking Instar?

**Target:**
- Serendipity: ON (maxPerSession: 3)
- Coherence gate: OFF globally, but false-claim-detection hooks ON
- Evolution: Data collection ON, auto-implementation OFF
- Post-action-reflection hook: ON (feeds learning registry)
- Evolution jobs: commitment-check ON, insight-harvest ON, evolution-review OFF or approval-gated

### Answer: YES, achievable without forking. Here's how:

| Feature | Mechanism | Modification Type |
|---------|-----------|-------------------|
| Serendipity ON | `config.serendipity.enabled: true, maxPerSession: 3` | Config only |
| Coherence gate OFF | `config.responseReview.enabled: false` | Config only |
| False-claim hooks ON | Keep `claim-intercept.js` and `claim-intercept-response.js` in settings.json | No change (installed by default) |
| Evolution data ON | `config.evolution: { stateDir: '.instar/state/evolution' }` | Config only |
| Auto-implementation OFF | `config.evolution.autoImplement: false` | Config only |
| Post-action-reflection ON | Already unconditional | No change (fires always) |
| commitment-check ON | Keep `enabled: true` in jobs.json | No change |
| insight-harvest ON | Keep `enabled: true` in jobs.json | No change |
| evolution-review OFF | Set `enabled: false` in jobs.json | jobs.json edit |
| **OR** evolution-review approval-gated | Edit `execute.value` prompt to stop after approve/reject step | jobs.json prompt edit |

**Zero source changes required.** All modifications are to user-editable config/jobs files.

---

## Question 2: If not achievable via config alone, what's the minimal modification?

**It IS achievable via config alone** (see above). The only "modifications" are:

1. Edit `.instar/config.json` — set `responseReview.enabled: false`, `serendipity.enabled: true`
2. Edit `.instar/jobs.json` — set `evolution-review.enabled: false` (or edit its prompt)
3. Leave everything else at defaults

**No hook registration changes needed.** The claim-intercept hooks are installed by default and don't check the `responseReview.enabled` flag. The response-review hook checks the flag at runtime and exits silently when disabled.

**No source changes. No fork. No custom hooks required for this configuration.**

---

## Question 3: Risk of partial configuration

### Serendipity ON + Evolution OFF: Finding accumulation

**Risk: Low.** Findings accumulate in `.instar/state/serendipity/` as JSON files. The session-start hook reports "N pending finding(s)" to every session.

**Unbounded growth?** No built-in cleanup mechanism, but:
- Findings are small JSON files (~1KB each)
- `maxPerSession: 3` limits capture rate
- Session-start hook just counts files in the directory
- At 3/session × 5 sessions/day = ~15 findings/day = ~5KB/day
- Even after a year: ~5,500 files, ~5.5MB — negligible

**Mitigation:** Run `/triage-findings` periodically to dismiss irrelevant findings. Or add a cron job that deletes findings older than N days.

### Evolution ON + evolution-review OFF: Proposal accumulation

**Risk: Low-Medium.** Proposals from `/evolve` calls accumulate in `evolution-proposals.json`.
- `maxProposals` config limits retention (default varies)
- Without the review job, proposals are never evaluated
- The `post-action-reflection` hook will keep suggesting `/evolve` to agents
- Agents may create proposals that never get reviewed

**Mitigation:** Either:
- Run `/triage-findings` manually for serendipity
- Set `maxProposals` to a reasonable limit (e.g., 50)
- Periodically run `insight-harvest` (ON by default) which processes learnings

### Post-action-reflection firing for all sessions

**Risk: Low.** The hook fires unconditionally after significant actions. If evolution endpoints are available (evolution ON), the `/learn`, `/evolve` etc. commands work. The hook just injects a suggestion — agents can ignore it.

**Annoyance factor:** Job sessions (like health-check) get evolution prompts. This wastes a few tokens but doesn't cause errors.

---

## Question 4: Exact config.json structure

```json
{
  "serendipity": {
    "enabled": true,
    "maxPerSession": 3
  },
  "responseReview": {
    "enabled": false
  },
  "evolution": {
    "stateDir": ".instar/state/evolution",
    "autoImplement": false,
    "maxProposals": 50,
    "maxLearnings": 200,
    "maxGaps": 100,
    "maxActions": 100
  }
}
```

**Plus in `.instar/jobs.json`, modify:**
```json
{
  "slug": "evolution-review",
  "enabled": false
}
```

**(Or for approval-gated mode, replace `enabled: false` with an edited prompt that stops after triage.)**

**Leave untouched:**
- `claim-intercept.js` hooks in settings.json (installed by default, independent)
- `post-action-reflection` hook (fires unconditionally, cannot be disabled via config)
- `commitment-check` job (enabled by default)
- `insight-harvest` job (enabled by default)
- `serendipity-capture.sh` (installed by default, runtime-gated)

---

## Configuration Dependency Map

```
serendipity.enabled ──────────────► serendipity-capture.sh runtime gate
                                    session-start.sh pending count
                                    /triage-findings skill
                                        └──► POST /evolution/proposals (requires evolution ON)

responseReview.enabled ───────────► response-review.js runtime gate
                                    (claim-intercept hooks: INDEPENDENT, always fire)

evolution config present ─────────► EvolutionManager instantiated
                                    API endpoints return 200 (not 503)
                                    /learn, /evolve, /gaps, /commit-action work
                                    action queue available

evolution.autoImplement ──────────► processProposalAutonomously() gated

jobs.json enabled flags ──────────► Per-job scheduling
                                    (post-action-reflection: INDEPENDENT, always fires)
```
