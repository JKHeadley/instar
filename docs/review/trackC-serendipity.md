# Track C: Serendipity Protocol Granularity

## Summary
Serendipity is fully independent from evolution. The capture script is installed unconditionally but checks `serendipity.enabled` at runtime. Findings accumulate regardless of evolution state and become promotable when evolution is later enabled. Session-start notifications fire for ALL sessions including job sessions.

---

## C1: Does serendipity work independently from evolution? [VERIFIED]

**Location:** `src/server/routes.ts:4818-4882`, `src/templates/scripts/serendipity-capture.sh:52-74`

**Yes, completely independent.** Serendipity routes operate directly on the filesystem without any evolution system checks. The capture script checks only `serendipity.enabled` and `serendipity.maxPerSession` — never evolution config.

**If evolution is disabled:** Findings accumulate in `.instar/state/serendipity/` waiting to be triaged. The `/triage-findings` skill can dismiss or flag for manual review, but cannot promote to evolution proposals (that endpoint returns 503).

---

## C2: Does /triage-findings require evolution? [INFERRED]

**Location:** `src/commands/init.ts:1730-1736`

**Partially.** The skill itself works without evolution — it can dismiss findings or flag them for review. But the "promote to evolution proposal" routing option calls `POST /evolution/proposals`, which returns 503 if evolution is disabled.

**Behavior:** You can triage (dismiss/review) but cannot promote. No error crash — the promotion step just fails gracefully.

---

## C3: Is serendipity-capture.sh installed unconditionally? [VERIFIED]

**Location:** `src/commands/init.ts:321-322,667-669,2618,3348-3377`

**Yes.** Installed during init in all paths (fresh project, existing project, standalone agent) with no config check.

**Runtime gating:** The script reads `serendipity.enabled` from config.json at execution time (line 53-64). If disabled, exits with "Serendipity protocol is disabled in config."

**CLAUDE.md awareness:** The protocol is documented in the CLAUDE.md template regardless of config, so agents know about it even when disabled.

---

## C4: Can maxPerSession be changed at runtime? [VERIFIED]

**Location:** `src/templates/scripts/serendipity-capture.sh:66-74`

**Effectively yes** — the script reads `maxPerSession` from `.instar/config.json` at each invocation. Edit the config file and the next capture attempt reads the new value. No server restart needed.

However, there's no runtime API endpoint to change it — must edit the file directly.

---

## C5: Session-start notification for all sessions? [VERIFIED]

**Location:** `src/templates/hooks/session-start.sh:75-92`

**Yes, ALL sessions.** The hook fires unconditionally for every session start. It checks `if [ -d "$SERENDIPITY_DIR" ]` — whether the directory exists, not whether the session is interactive. A `health-check` job session will be told about pending findings.

---

## C6: Accumulated findings when evolution is later enabled? [VERIFIED]

**Location:** `src/commands/init.ts:1726`

**Findings remain available.** They're stored as JSON files in `.instar/state/serendipity/` with no timestamp coupling or session dependency. Enabling evolution makes the `POST /evolution/proposals` endpoint available, and the `/triage-findings` skill can then promote accumulated findings.

No staleness mechanism — findings persist indefinitely until triaged.
