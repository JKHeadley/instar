/**
 * Lint: shipped built-in job templates must authenticate their API calls.
 *
 * Born from EVO-007 / ACT-984 (2026-07-25). Five shipped job templates carried
 * `gate:` lines with a Bearer header but PROMPT BODIES that called authenticated
 * endpoints with a bare `curl -s http://localhost:.../evolution/...`. Every one of
 * those 12 calls returns 401 `Missing or invalid Authorization header` at runtime,
 * so the job body silently did nothing while the gate said "there is work to do".
 * The gate passing is exactly what made it invisible.
 *
 * Two rules, both mechanical:
 *   1. Every curl in a shipped template that targets a NON-public endpoint must
 *      carry an `Authorization: Bearer` header.
 *   2. A template that USES `$AUTH` must DEFINE `AUTH=` (an undefined variable
 *      expands to empty and produces the same 401 as no header at all).
 *
 * This is a CI lint — a signal with no runtime authority. It cannot block an
 * agent at runtime; it fails the build so the template never ships broken.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATE_DIR = path.resolve(__dirname, '../../src/scaffold/templates/jobs/instar');
const MIDDLEWARE_PATH = path.resolve(__dirname, '../../src/server/middleware.ts');

/**
 * Endpoints the server serves WITHOUT the API bearer token.
 * Mirrors the exemptions in src/server/middleware.ts authMiddleware(). The
 * `drift guard` test below asserts each entry still exists there, so this list
 * cannot silently rot into a false pass if a route stops being public.
 */
const PUBLIC_PATHS = ['/health', '/ping', '/jobs/events', '/dashboard/unlock'];
const PUBLIC_PREFIXES = ['/threadline/', '/secrets/drop/', '/mcp/approve/', '/mesh/rpc', '/a2a/'];

export interface AuthViolation {
  file: string;
  line: number;
  endpoint: string;
  snippet: string;
}

function isPublic(endpointPath: string): boolean {
  if (PUBLIC_PATHS.includes(endpointPath)) return true;
  return PUBLIC_PREFIXES.some(p => endpointPath.startsWith(p));
}

/**
 * Find every curl call in `content` that hits a non-public localhost endpoint
 * without an Authorization header. Curl invocations in these templates are
 * single-line, so the line IS the command scope.
 */
export function findUnauthenticatedCalls(content: string, file = '<inline>'): AuthViolation[] {
  const violations: AuthViolation[] = [];
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    if (!line.includes('curl')) return;

    // A single line may hold more than one curl; scope each to its own segment.
    const segments = line.split(/(?=curl\s)/).filter(s => s.includes('curl'));

    for (const segment of segments) {
      const urlMatch = segment.match(/localhost:(?:\$\{INSTAR_PORT:-\d+\}|\$PORT|\d+)([^\s"'|)]*)/);
      if (!urlMatch) continue;

      const endpointPath = (urlMatch[1] || '/').split('?')[0];
      if (isPublic(endpointPath)) continue;

      if (!/Authorization:\s*\\?"?Bearer/.test(segment)) {
        violations.push({
          file,
          line: idx + 1,
          endpoint: endpointPath,
          snippet: segment.trim().slice(0, 120),
        });
      }
    }
  });

  return violations;
}

/**
 * Templates that reference $AUTH without ever assigning it.
 *
 * The assignment is NOT line-anchored on purpose: several templates legitimately
 * present it as a prose step inside backticks (`0. **Set auth context:** \`AUTH=...\``).
 * Anchoring to line-start falsely accused three healthy templates during
 * development, so the guard only requires that `AUTH=` is not itself a
 * dereference (`$AUTH=`) or a longer identifier (`XAUTH=`).
 */
export function findUndefinedAuthVar(content: string, file = '<inline>'): string[] {
  const usesAuth = /\$\{?AUTH\}?\b/.test(content);
  const definesAuth = /(?<![$\w])AUTH=/.test(content);
  return usesAuth && !definesAuth ? [file] : [];
}

function templateFiles(): string[] {
  return fs.readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.md'));
}

describe('built-in job template auth lint', () => {
  it('every shipped template authenticates its non-public API calls', () => {
    const all: AuthViolation[] = [];

    for (const file of templateFiles()) {
      const content = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf-8');
      all.push(...findUnauthenticatedCalls(content, file));
    }

    const report = all.map(v => `  ${v.file}:${v.line} → ${v.endpoint}\n    ${v.snippet}`).join('\n');
    expect(all, `Unauthenticated calls to non-public endpoints:\n${report}`).toEqual([]);
  });

  it('no shipped template uses $AUTH without defining it', () => {
    const offenders: string[] = [];

    for (const file of templateFiles()) {
      const content = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf-8');
      offenders.push(...findUndefinedAuthVar(content, file));
    }

    expect(offenders, `Templates using $AUTH with no AUTH= definition: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the five EVO-007 templates carry the canonical env-first AUTH block', () => {
    // The config.json fallback alone is NOT sufficient: an agent whose
    // config.json authToken has drifted from the live server token (observed
    // 2026-07-25: 16-char config value rejected, 36-char env value accepted)
    // gets a 401 from a config-only read. $INSTAR_AUTH_TOKEN must come first.
    const fixed = [
      'evolution-overdue-check.md',
      'evolution-proposal-implement.md',
      'evolution-proposal-evaluate.md',
      'insight-harvest.md',
      'identity-review.md',
    ];

    for (const file of fixed) {
      const content = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf-8');
      expect(content, `${file} must prefer $INSTAR_AUTH_TOKEN`).toMatch(/AUTH="\$\{INSTAR_AUTH_TOKEN:-/);
    }
  });

  it('detects a violation in a known-bad body (lint actually bites)', () => {
    const bad = [
      '---',
      'name: Bad Job',
      '---',
      'Do the thing: curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/proposals?status=approved',
    ].join('\n');

    const found = findUnauthenticatedCalls(bad, 'bad.md');
    expect(found).toHaveLength(1);
    expect(found[0].endpoint).toBe('/evolution/proposals');
  });

  it('does not flag public endpoints', () => {
    const ok = [
      'gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1',
      'ping it: curl -s http://localhost:$PORT/ping',
    ].join('\n');

    expect(findUnauthenticatedCalls(ok, 'ok.md')).toEqual([]);
  });

  it('accepts an escaped Bearer header (echoed-instruction form)', () => {
    const echoed =
      'echo "Signal: curl -s -X POST -H \\"Authorization: Bearer \\$INSTAR_AUTH_TOKEN\\" http://localhost:${INSTAR_PORT:-4042}/reflection/record"';
    expect(findUnauthenticatedCalls(echoed, 'echoed.md')).toEqual([]);
  });

  it('accepts an AUTH definition presented as a prose step in backticks', () => {
    // Regression: the first draft anchored the definition to line-start and
    // falsely accused initiative-digest-review / mentor-onboarding /
    // org-intent-drift-audit, all of which define AUTH inside backticks.
    const prose = [
      '0. **Set auth context:** `AUTH="${INSTAR_AUTH_TOKEN:-}"`',
      'Then: curl -s -H "Authorization: Bearer $AUTH" http://localhost:$PORT/evolution',
    ].join('\n');

    expect(findUndefinedAuthVar(prose, 'prose.md')).toEqual([]);
  });

  it('still catches a genuine undefined $AUTH', () => {
    const bad = 'curl -s -H "Authorization: Bearer $AUTH" http://localhost:$PORT/evolution';
    expect(findUndefinedAuthVar(bad, 'bad.md')).toEqual(['bad.md']);
  });

  it('drift guard: every exempted path is still public in middleware.ts', () => {
    const middleware = fs.readFileSync(MIDDLEWARE_PATH, 'utf-8');
    for (const p of [...PUBLIC_PATHS, ...PUBLIC_PREFIXES]) {
      expect(middleware, `${p} is exempted by the lint but no longer appears in authMiddleware`).toContain(p);
    }
  });
});
