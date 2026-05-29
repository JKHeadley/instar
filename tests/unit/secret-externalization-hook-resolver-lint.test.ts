/**
 * Lint: hooks/scripts/migrator-emitted templates must NOT read authToken
 * directly from config.json without an INSTAR_AUTH_TOKEN env-first fallback
 * and a string-type guard.
 *
 * Why this lint exists:
 *
 * The instar server moves authToken out of plaintext config.json into an
 * encrypted secret store on first multi-machine pairing (`SecretMigrator`).
 * The on-disk value becomes the literal placeholder `{ "secret": true }`.
 * Any reader that does a raw `cfg.authToken` or
 * `json.load(...).get('authToken','')` then gets a non-string (an object or
 * Python dict repr) and sends `[object Object]` / `{'secret': True}` as a
 * Bearer token. The server rejects every request 403, but the failure is
 * SILENT inside the caller — the hook just emits no output. The user sees an
 * agent that has no idea what the conversation is about.
 *
 * This bug already happened twice in the fleet:
 *   1. 2026-05-28: telegram-reply.sh 403s after secret-externalization.
 *   2. 2026-05-29: telegram-topic-context.sh stopped injecting topic history.
 *                  The agent came back from compaction with no idea what the
 *                  user had been saying, produced an incoherent reply, and the
 *                  user (Justin) had to manually trace it back to this class.
 *
 * The rule:
 *
 *   For every place that reads authToken from `.instar/config.json`,
 *   `INSTAR_AUTH_TOKEN` env MUST be tried first AND the disk fallback must
 *   guard against non-string values. SessionManager + JobScheduler already
 *   inject INSTAR_AUTH_TOKEN into every spawned context, so the env path is
 *   the canonical one.
 *
 * What's banned:
 *
 *   - Shell:   `python3 ... json.load(...).get('authToken','')` without a
 *              preceding `${INSTAR_AUTH_TOKEN:-...}` guard.
 *   - Shell:   `grep -o '"authToken":"..."'` without an env guard.
 *   - Node:    `cfg.authToken || ''` / `cfg.authToken ?? ''` without an
 *              `INSTAR_AUTH_TOKEN` env fallback OR a typeof === 'string'
 *              check.
 *
 * What's allowed:
 *
 *   - Callsites that go through `loadConfig()` (in-process; that path runs
 *     `mergeConfigWithSecrets` and returns the real value).
 *   - The migrator's own setup-time code (it owns the SecretStore).
 *   - The lint test itself (this file references the patterns to detect
 *     them — we use sentinel comments instead of raw substring matching to
 *     avoid a self-trip).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

const ALLOWLIST = new Set<string>([
  // The lint test itself.
  'tests/unit/secret-externalization-hook-resolver-lint.test.ts',
  // The CLI loads config via the in-process loadConfig() which merges secrets.
  // Pattern matches incidentally because the file mentions the field name.
  'src/cli.ts',
  // The PolicyEnforcementLayer uses Config.loadConfig() in-process.
  'src/core/PolicyEnforcementLayer.ts',
  // SecretMigrator owns the canonical SecretStore + plaintext config path.
  'src/core/SecretMigrator.ts',
  // SecretStore implementation — privileged.
  'src/core/SecretStore.ts',
  // ListenerSessionManager constructor receives the resolved token as a param.
  'src/threadline/ListenerSessionManager.ts',
]);

function walk(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, exts));
    } else if (exts.some(e => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function relRepo(p: string): string {
  return path.relative(REPO_ROOT, p).replace(/\\/g, '/');
}

// ── Shell patterns ───────────────────────────────────────────────────────

// Forbidden: python3 -c "...json.load(...).get('authToken'...)..." without a
// string-type guard. Nested parens (open('$CONFIG_FILE')) make a strict regex
// fragile, so we match per-line on the co-occurrence of `json.load` and
// `authToken` — the only realistic shape this pattern takes.
const STRING_GUARD_REGEX = /isinstance\([^,]+,\s*str\)/;
const ENV_FIRST_REGEX = /INSTAR_AUTH_TOKEN/;
function hasRawPyAuthRead(content: string): boolean {
  return content.split('\n').some(line => /json\.load\(/.test(line) && /['"]authToken['"]/.test(line));
}

// Forbidden: grep -o '"authToken":"..."' without an INSTAR_AUTH_TOKEN env guard
// in the same file.
const RAW_GREP_AUTHTOKEN = /grep -o[E]?\s+['"]"authToken"/;

describe('hooks/scripts: authToken reads must survive secret-externalization', () => {
  const shellFiles = [
    ...walk(path.join(REPO_ROOT, 'src/templates'), ['.sh', '.mjs', '.py']),
    ...walk(path.join(REPO_ROOT, 'scripts'), ['.sh', '.mjs', '.js']),
  ];

  it('every shell/mjs auth-token read goes through env-first with a string-type guard', () => {
    const offenders: string[] = [];
    for (const f of shellFiles) {
      const rel = relRepo(f);
      if (ALLOWLIST.has(rel)) continue;
      const content = fs.readFileSync(f, 'utf-8');

      if (hasRawPyAuthRead(content)) {
        // python3 -c "...authToken..." appears. Must have BOTH env-first AND
        // string-type guard somewhere in the file.
        if (!ENV_FIRST_REGEX.test(content) || !STRING_GUARD_REGEX.test(content)) {
          offenders.push(`${rel}: python3 authToken read lacks INSTAR_AUTH_TOKEN env-first OR isinstance(_, str) guard`);
        }
      }

      if (RAW_GREP_AUTHTOKEN.test(content)) {
        // grep -o '"authToken":"..."' read. Must be guarded by INSTAR_AUTH_TOKEN
        // env (the grep itself only matches a plaintext string token, so the
        // externalization case auto-yields empty — env is the cure).
        if (!ENV_FIRST_REGEX.test(content)) {
          offenders.push(`${rel}: grep authToken read lacks INSTAR_AUTH_TOKEN env-first`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── PostUpdateMigrator embedded-string patterns ──────────────────────────

describe('PostUpdateMigrator emitted templates: same rule', () => {
  it('the migrator does not emit any raw authToken-from-config bash pattern', () => {
    const f = path.join(REPO_ROOT, 'src/core/PostUpdateMigrator.ts');
    const s = fs.readFileSync(f, 'utf-8');

    // Search for the exact dangerous bash patterns inside template-literal blocks.
    // (We allow the patterns to appear inside COMMENT lines or inside the SAFE
    // string-guarded form.)
    const lines = s.split('\n');
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // Raw python read with no string-type guard.
      const pyMatch = /json\.load\(open\([^)]*\)\)\.get\(['"]authToken['"]/.test(line);
      const stringGuard = /isinstance\([^,]+,\s*str\)/.test(line);
      if (pyMatch && !stringGuard) {
        offenders.push(`PostUpdateMigrator.ts:${i + 1}: raw json.load authToken without isinstance(_, str) guard`);
      }

      // Raw grep -o '"authToken":"..."' without env-first on the same or previous line.
      const grepMatch = /grep -o\s+['"]+"authToken"/.test(line);
      if (grepMatch) {
        // Look at this line and the 5 preceding lines for INSTAR_AUTH_TOKEN env-first.
        const window = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
        if (!/INSTAR_AUTH_TOKEN/.test(window)) {
          offenders.push(`PostUpdateMigrator.ts:${i + 1}: raw grep authToken without INSTAR_AUTH_TOKEN env-first`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── src/ Node patterns ───────────────────────────────────────────────────

describe('Node reads of authToken: same rule applies', () => {
  it('every src/**/*.ts direct-disk read of config.json + authToken has env-first OR typeof string guard', () => {
    // The safe path is `loadConfig()` (from src/core/Config.ts) — it calls
    // mergeConfigWithSecrets() and returns the real string. This lint is
    // therefore scoped to callers that bypass loadConfig() by doing their
    // OWN `JSON.parse(fs.readFileSync(...config.json...))` and then accessing
    // `.authToken` on the parsed object. Those are the ones at risk.
    const srcFiles = walk(path.join(REPO_ROOT, 'src'), ['.ts']);
    const offenders: string[] = [];

    for (const f of srcFiles) {
      const rel = relRepo(f);
      if (ALLOWLIST.has(rel)) continue;
      const content = fs.readFileSync(f, 'utf-8');

      // Does this file do a raw disk read of config.json AND access .authToken?
      const doesRawDiskRead = /JSON\.parse\(\s*(?:fs|nodeFs)\.readFileSync\([^)]*config\.json/.test(content)
        || /readFileSync\(\s*[^,]*config\.json/.test(content);
      const accessesAuthTokenField = /\.authToken\b/.test(content);
      if (!doesRawDiskRead || !accessesAuthTokenField) continue;

      // Must have INSTAR_AUTH_TOKEN env-first OR a typeof-string check
      // protecting every read of .authToken. The typeof check can be either
      // direct (`typeof cfg.authToken === 'string'`) or via a guard helper
      // (`typeof v === 'string'`) — both reject the { secret: true } placeholder.
      const hasEnvFirst = ENV_FIRST_REGEX.test(content);
      const hasDirectTypeofGuard = /typeof\s+[A-Za-z_$][\w$]*\.authToken\s*===\s*['"]string['"]/.test(content);
      const hasHelperTypeofGuard = /typeof\s+[A-Za-z_$][\w$]*\s*===\s*['"]string['"]/.test(content);
      if (!hasEnvFirst && !hasDirectTypeofGuard && !hasHelperTypeofGuard) {
        offenders.push(`${rel}: raw disk read of config.json + .authToken access without INSTAR_AUTH_TOKEN env-first OR typeof string guard`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
