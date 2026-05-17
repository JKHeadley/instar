---
title: Lifeline shadow-install self-heal + fleet watchdog hardening
date: 2026-05-17
author: echo
review-convergence: internal-plus-second-pass-2026-05-17
approved: true
approved-by: Justin
approved-via: Telegram topic 5447 ("approved" at 2026-05-17 21:18 UTC)
eli16-overview: lifeline-shadow-install-self-heal.eli16.md
---

# Spec — Lifeline shadow-install self-heal + fleet watchdog hardening

**Date:** 2026-05-17
**Author:** echo
**Status:** in-flight (approved 2026-05-17 in topic 5447)
**Reference:** Today's incident — AI Guy down for ~4 days because the shadow-install directory vanished. The lifeline boot wrapper crash-looped 37,659+ times; the fleet watchdog detected the failure and tried to heal it every 5 minutes but its `npm install` step failed silently under launchd's empty PATH; no alert ever reached Justin.

## Background

On 2026-05-13, the shadow-install directory under `~/Documents/Projects/ai-guy/.instar/shadow-install/` disappeared. Root-cause for the deletion is unknown — leading hypotheses are an aborted auto-update, a manual `rm`, or a filesystem-level event. Whatever the cause, the consequence is what we care about: a single missing directory permanently dead-ended the agent.

Three layers had to fail for that outcome:

1. **Boot wrapper had no self-heal for missing SHADOW.** The wrapper checks for `node_modules/instar/dist/cli.js`, prints "Run: npm install instar --prefix …", and exits 1. launchd's KeepAlive immediately respawned it. The wrapper crash-looped at the 10-second ThrottleInterval cadence for 4 days.

2. **Fleet watchdog's heal step couldn't actually run.** `~/.instar/instar-watchdog.sh` (which is the standalone user-level fleet supervisor, not the per-agent `health-watchdog.sh` shipped in instar src) DOES detect crash-looping agents and DOES try to reinstall their shadow-installs. But the script invokes `npm install`, npm's `#!/usr/bin/env node` shebang resolves `env` against launchd's empty PATH, and `node` is not found. The watchdog log shows literally:

   ```
   [2026-05-17 14:11:49] HEAL: ai.instar.ai-guy — shadow install missing, reinstalling
   env: node: No such file or directory
   [2026-05-17 14:11:49] HEAL-FAIL: ai.instar.ai-guy — npm install failed
   [2026-05-17 14:11:49] CRASH-LOOP: ai.instar.ai-guy — no fixable issues found, may need manual intervention
   ```

   …every 5 minutes for 4 days.

3. **No escalation to user when heal kept failing.** The watchdog wrote "may need manual intervention" to a log file. No alert reached Telegram. This is the same shape as the Inspec failure on 2026-04-29 — different layer, identical anti-pattern: detection works, repair fails silently, escalation missing.

This spec closes all three layers.

## Goal

Make this exact failure mode (missing shadow-install + watchdog heal fails + Justin never knows) impossible. After this change ships:

- A boot wrapper that finds no shadow-install attempts ONE reinstall before exiting, and almost always succeeds.
- A fleet watchdog whose self-heal `npm install` actually runs under launchd.
- A fleet watchdog that, when its self-heal fails for N cycles in a row, escalates to the user via any healthy peer agent's existing tone-gated `/attention` Telegram path.

## Scope (must-haves)

### Change 1 — Boot wrapper attempts shadow-install reinstall before exiting

**File:** `src/commands/setup.ts` — `installBootWrapper()` jsWrapper template (~line 1010 area where `!fs.existsSync(SHADOW)` is checked).

Replace the existing "exit 1 with error message" branch with:

```js
if (!fs.existsSync(SHADOW)) {
  // Attempt one-shot reinstall before giving up. Debounced via marker file
  // so launchd KeepAlive throttling doesn't trigger 360 reinstalls per hour.
  const HEAL_MARKER = path.join(SHADOW_DIR + '.heal-attempted');
  const now = Date.now();
  let lastAttempt = 0;
  try { lastAttempt = parseInt(fs.readFileSync(HEAL_MARKER, 'utf-8'), 10) || 0; } catch {}

  // Only one attempt per 5 minutes to bound launchd-induced storms.
  if (now - lastAttempt > 5 * 60 * 1000) {
    fs.writeFileSync(HEAL_MARKER, String(now));
    process.stderr.write('[instar-boot] Shadow install missing — attempting one-shot reinstall\n');

    try {
      // Resolve a usable node + npm. Prefer the symlinked node; fall back to well-known paths.
      // npm's shebang is `#!/usr/bin/env node`, so we MUST invoke it via an absolute node path
      // when PATH may be empty (launchd-spawned children).
      const candidateNodes = [
        process.execPath,
        '/opt/homebrew/bin/node',
        '/usr/local/bin/node',
      ].filter(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

      const nodeBin = candidateNodes[0];
      // Locate npm relative to node (sibling) or via well-known paths.
      const npmCandidates = [
        path.join(path.dirname(nodeBin), 'npm'),
        '/opt/homebrew/bin/npm',
        '/usr/local/bin/npm',
      ].filter(p => { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } });

      if (!nodeBin || npmCandidates.length === 0) throw new Error('no node/npm found');

      fs.mkdirSync(SHADOW_DIR, { recursive: true });
      // Write a minimal package.json so npm has a project to install into.
      const pkg = { name: 'instar-shadow', private: true, dependencies: { instar: 'latest' } };
      fs.writeFileSync(path.join(SHADOW_DIR, 'package.json'), JSON.stringify(pkg, null, 2));
      execFileSync(nodeBin, [npmCandidates[0], 'install', '--no-audit', '--no-fund', '--silent'], {
        cwd: SHADOW_DIR,
        stdio: 'inherit',
        timeout: 5 * 60 * 1000,
      });

      if (fs.existsSync(SHADOW)) {
        process.stderr.write('[instar-boot] Reinstall succeeded — continuing boot\n');
      } else {
        throw new Error('reinstall ran but SHADOW still missing');
      }
    } catch (err) {
      process.stderr.write('[instar-boot] Reinstall failed: ' + err.message + '\n');
      process.stderr.write('Run manually: npm install instar --prefix ' + SHADOW_DIR + '\n');
      process.exit(1);
    }
  } else {
    process.stderr.write('[instar-boot] Shadow install missing; last heal attempt ' +
      Math.floor((now - lastAttempt) / 1000) + 's ago, skipping (debounce 5min)\n');
    process.exit(1);
  }
}
```

The bash wrapper gets a similar treatment for parity.

**Why debounce.** Without it, launchd's 10-second ThrottleInterval would trigger ~30 reinstall attempts before npm even finished one. The 5-minute marker file makes the heal idempotent across throttled restarts.

**Why one attempt.** A single attempt is enough to recover from the 99% case (directory was deleted but everything else is fine). If the reinstall genuinely fails (no network, permissions, disk full), repeated attempts won't fix it and just waste resources. The marker file ensures we don't loop on this.

### Change 2 — Fleet watchdog moves into instar src + PATH fix

**New file:** `src/templates/scripts/instar-watchdog.sh`. This is the user-level fleet watchdog that supervises every agent on the machine. It was previously hand-rolled in `~/.instar/instar-watchdog.sh` with no migration path.

**Existing user-level script** at `~/.instar/instar-watchdog.sh` will be overwritten by `PostUpdateMigrator.migrateFleetWatchdog()` on next update.

**PATH fix.** The current script uses bare `npm install` which fails under launchd's empty PATH. Rewrite the heal path to resolve absolute paths:

```bash
# Resolve node + npm with launchd-empty-PATH-aware fallbacks.
# /usr/bin/env is available unconditionally; everything else we resolve absolutely.
NODE_BIN=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done
NPM_BIN=""
if [ -n "$NODE_BIN" ]; then
  candidate_npm="$(dirname "$NODE_BIN")/npm"
  [ -r "$candidate_npm" ] && NPM_BIN="$candidate_npm"
fi
if [ -z "$NPM_BIN" ]; then
  for candidate in /opt/homebrew/bin/npm /usr/local/bin/npm; do
    [ -r "$candidate" ] && NPM_BIN="$candidate" && break
  done
fi

if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
  log "HEAL-FAIL: $label — no node/npm binary found"
  return 1
fi

# Invoke npm via absolute node so npm's #!/usr/bin/env node shebang doesn't break.
if "$NODE_BIN" "$NPM_BIN" install instar --prefix "$state_dir/shadow-install" >> "$LOG_FILE" 2>&1; then
  log "HEAL-OK: $label — shadow install restored"
fi
```

**Plist PATH fix.** The launchd plist for `ai.instar.watchdog` must include an explicit PATH containing `/opt/homebrew/bin:/usr/local/bin` so any subshell utilities the watchdog invokes also find their tools. This is belt-and-suspenders next to the absolute paths above.

### Change 3 — Peer-escalation when watchdog heal fails N cycles

**File:** `src/templates/scripts/instar-watchdog.sh` (continued).

After the existing HEAL-FAIL log line, track the consecutive failure count per label and escalate when it crosses threshold:

```bash
FAIL_STATE="$HEAL_STATE_DIR/$label.consecutive-heal-fails"
current=0
[ -r "$FAIL_STATE" ] && current=$(cat "$FAIL_STATE" 2>/dev/null || echo 0)
current=$((current + 1))
echo "$current" > "$FAIL_STATE"

if [ "$current" -ge 3 ]; then
  # Escalate to a healthy peer agent. The peer's existing /attention endpoint
  # routes through MessagingToneGate (B12-B14 rules), producing a plain-English
  # Telegram alert to the user. This is the same authority the agent's own
  # DegradationReporter uses — we just call it from outside the dead agent.
  escalate_via_peer "$label" "$current"
fi
```

The `escalate_via_peer` function:

1. Discover healthy peers: iterate `launchctl list | grep ai.instar.` minus the dead label, probe each one's `/health` endpoint, pick the first that returns 200. Use that agent's auth token from its `.instar/config.json`.

2. POST to `/attention`:

```bash
curl -sS -X POST "http://localhost:${peer_port}/attention" \
  -H "Authorization: Bearer $peer_auth" \
  -H "Content-Type: application/json" \
  -H "X-Instar-Request: 1" \
  -d "{
    \"id\": \"fleet-watchdog-heal-fail-${label}-${current}\",
    \"title\": \"${dead_agent} is offline\",
    \"summary\": \"${dead_agent} has been crash-looping for ${minutes} minutes; my repair attempts aren't working.\",
    \"description\": \"Want me to dig in?\",
    \"category\": \"degradation\",
    \"priority\": \"HIGH\"
  }"
```

The `category: "degradation"` triggers the `isHealthAlert` branch in `routes.ts:5678`, which feeds the message through `checkOutboundMessage` with `messageKind: 'health-alert'` and `jargon: true`. That invokes `MessagingToneGate` with the B12-B14 ruleset:
- B12 (`HEALTH_ALERT_INTERNALS`) blocks jargon ("crash-loop", "lifeline", "shadow-install"). We use plain-English copy on purpose to pass it.
- B13 (`HEALTH_ALERT_SUPPRESSED_BY_HEAL`) blocks if a registered SelfHealer already fixed it. Doesn't apply here — the dead agent has no running SelfHealer.
- B14 (`HEALTH_ALERT_NO_CTA`) blocks if there's no actionable next step. "Want me to dig in?" is the CTA.

If the gate blocks anyway, `routes.ts:5685` returns 422 with the canonical `SAFE_HEALTH_ALERT_TEMPLATE` fallback: "Something on my end stopped working and I haven't been able to fix it on my own. Want me to dig in?" That's the floor.

3. Reset the consecutive-failure counter on heal-success OR after escalation (so we don't re-page every cycle once the user is notified).

**Why use an existing peer's server.** The dead agent has no server — by definition, that's why we're escalating. Telegram bot tokens are per-agent. The only path to surface a Telegram alert is through SOME running agent's server. Using a peer is mechanically the same as the dead agent would have done if it were up.

### Change 4 — Watchdog ships its own launchd plist with explicit PATH

**File:** `src/commands/setup.ts` — add `installFleetWatchdog()` that:
- Writes `~/.instar/instar-watchdog.sh` from the template in Change 2.
- Writes `~/Library/LaunchAgents/ai.instar.watchdog.plist` with:
  - StartInterval=300 (5 min)
  - RunAtLoad=true
  - **EnvironmentVariables.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"** (the fix)
  - StandardOut/Err paths into `~/.instar/`

Wired into `instar setup` for fresh installs and into `PostUpdateMigrator.migrateFleetWatchdog()` for existing installs.

## Non-goals

- **Not building the v3 Remediator.** That spec (`docs/specs/SELF-HEALING-REMEDIATOR-V3-CONSOLIDATED-SPEC.md`, approved 2026-05-13) owns the full architecture for orchestrated healing with capability tokens, runbooks, and NovelFailureReviewer. This PR is plumbing that the Remediator's Tier-3 "Fleet Intelligence" will eventually subsume. Both authors of this spec (me) and the Remediator spec agree on the absorption point: the watchdog script's peer-escalation call becomes a runbook that emits to the Remediator's audit log, and NovelFailureReviewer consumes the consecutive-failure pattern instead of the watchdog tracking it. Until then, the plumbing is correct and self-contained.
- **Not adding new authorities.** All decision authority remains in `MessagingToneGate` / `/attention`. The watchdog produces a SIGNAL (consecutive-heal-fail-count) consumed by an existing AUTHORITY (the tone gate). Signal-vs-authority compliant.
- **Not changing the per-agent `health-watchdog.sh`.** That's a different artifact, working as designed.
- **Not addressing WHY the shadow-install vanished.** The root cause is unknown and lower-frequency than the consequence we're fixing. If the deletion turns out to be a recurring auto-update bug, it gets its own follow-up spec.

## Acceptance criteria

1. **Boot-wrapper self-heal unit test.** Delete a fixture agent's `.instar/shadow-install/` directory. Run the boot wrapper directly. Assert: marker file is written, `npm install` runs, shadow-install is restored, wrapper continues to spawn CLI. Re-run within 5 min: assert the wrapper skips reinstall and exits 1 quickly (no second npm install attempt — debounce works).

2. **Watchdog PATH-resolution unit test.** Stub `$PATH=""` in the test shell. Invoke the heal function with a fixture project. Assert: heal succeeds (resolves `/opt/homebrew/bin/node` and adjacent `npm`), log line contains "HEAL-OK", shadow-install exists.

3. **Peer-escalation integration test.** Stand up two agent servers in tmpdirs. Mark agent A as "dead" (delete its shadow-install + leave launchd label loaded in error state). Run the watchdog three times. Assert:
   - First two cycles: HEAL-FAIL, counter increments to 2.
   - Third cycle: HEAL-FAIL, counter hits 3, escalation fires.
   - Agent B's `/attention` endpoint receives the POST, `MessagingToneGate` is invoked with `messageKind: 'health-alert'`, an attention item with `category: 'degradation'` is created.
   - Counter resets after escalation (no re-page on cycle 4).

4. **Tone-gate B12 compliance.** Verify the escalation payload doesn't trip B12 (`HEALTH_ALERT_INTERNALS`). The default copy is "AI Guy is offline — repair attempts aren't working — want me to dig in?" with NO jargon terms (no "crash-loop", "shadow", "lifeline", "process", "PID", etc.). If a future edit reintroduces jargon, the gate either reshapes the message or falls back to `SAFE_HEALTH_ALERT_TEMPLATE` — either way, the user gets a clean message.

5. **Migration parity.** Running `instar update` on an existing agent overwrites `~/.instar/instar-watchdog.sh` and `~/Library/LaunchAgents/ai.instar.watchdog.plist` to the latest template. Verified by snapshot test of the migrator output.

## Signal-vs-authority compliance

Required reference: `docs/signal-vs-authority.md`.

This change adds NO new blocking authority. Decision-points:

- **Boot-wrapper "shadow-install missing → attempt reinstall"** — structural file-existence check + recovery action. Per the principle, "Safety guards on irreversible actions" can be brittle, but this isn't even that — it's a recovery action with no block/allow surface. Hard-invariant check: file exists or doesn't.
- **Boot-wrapper debounce marker** — mechanic, not judgment. Idempotency-key class, explicitly listed as exempt.
- **Watchdog `consecutive-heal-fails >= 3`** — deterministic threshold counter. Produces a SIGNAL. The consumer (the `/attention` POST → ToneGate) is the authority. The counter never blocks anything; it triggers an escalation that the AUTHORITY then decides to allow or reshape.
- **Watchdog peer-discovery** — structural probing (launchctl list + /health 200). No judgment. The selected peer's `/attention` endpoint enforces all gating.
- **Telegram alert content** — owned entirely by the existing `MessagingToneGate` + B12-B14 ruleset. The watchdog provides a candidate message; the gate decides whether it ships, reshapes it, or falls back to `SAFE_HEALTH_ALERT_TEMPLATE`.

The escalation respects the principle's contract: brittle detectors (counter, file checks) produce signals, smart authority (tone gate with full conversational context) decides.

## Interactions

- **PR #111 (lifeline-self-heal-hardening, shipped 2026-04-29).** That PR added bind-failure escalation INSIDE the supervisor — for when the server tries to spawn and crashes. This PR adds reinstall-on-missing INSIDE the boot wrapper — for when the wrapper can't even spawn the server. Different upstream causes, no overlap.
- **v2.40 health-alert tone-gate wiring.** That work made `DegradationReporter` route through `MessagingToneGate` for *in-process* alerts. This PR uses the same gate from *out-of-process* by POSTing to a peer's `/attention`. The gate doesn't care which path the candidate came from; the routing is identical. No change to the gate itself.
- **v3 Remediator (approved 2026-05-13, not yet built).** The Remediator's Tier 3 (Fleet Intelligence) will absorb the cross-agent escalation path. When that ships, this watchdog escalation becomes a Tier-3 runbook that emits to the Remediator's audit log. Until then, the watchdog plumbing is self-contained and removes a 4-day outage class.

## Rollback

- **Code change:** revert the `installBootWrapper()` patch + the new `installFleetWatchdog()` + the watchdog template — three reverts in one PR. Ship as a patch release.
- **State:** the new `.heal-attempted` marker files in agent state dirs are harmless if left behind (deleted on first successful boot). Watchdog state files in `~/.instar/watchdog-state/` are append-only and equally harmless.
- **User-visible regression during rollback window:** none, except the obvious — agents that depended on the new self-heal would again be exposed to the original failure mode. Justin can keep the old patched script if needed.
- **Total rollback cost:** ~10 minutes. No data migration. No agent state repair beyond optional file cleanup.
