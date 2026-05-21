/**
 * Capabilities Discoverability — every route prefix must be discoverable.
 *
 * The CLAUDE.md template instructs agents: "Before EVER saying 'I don't have'
 * or 'this isn't available' — check what actually exists: curl /capabilities.
 * It is the source of truth about what you can do."
 *
 * That promise is only true if /capabilities actually enumerates every
 * primitive the server exposes. Without enforcement, primitives slip through:
 * Secret Drop shipped with full routes (POST /secrets/request, /secrets/retrieve,
 * /secrets/pending, DELETE /secrets/pending/:token), got documented in
 * the CLAUDE.md template, but was never added to the /capabilities response
 * body. Agents that trusted /capabilities as authoritative reached for unsafe
 * credential-intake workarounds because the discovery primitive lied.
 *
 * This lint catches that class of regression structurally. It walks routes.ts
 * for every top-level prefix (`/secrets`, `/views`, etc.) and asserts each
 * either appears in the /capabilities response body or is on the explicit
 * INTERNAL_ALLOWLIST below.
 *
 * Adding a new prefix that is neither surfaced nor allowlisted will fail this
 * test until the author makes a deliberate choice about discoverability.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const routesSource = fs.readFileSync(
  path.join(process.cwd(), 'src/server/routes.ts'),
  'utf-8',
);

/**
 * Endpoints that are intentionally not surfaced in /capabilities. These are
 * meta endpoints (health checks, the capabilities route itself), internal
 * RPCs called only by other instar processes, or deprecated/internal-only
 * routes. Adding to this list is a deliberate choice — every entry should
 * have a one-line reason after it.
 */
const INTERNAL_ALLOWLIST: ReadonlyArray<string> = [
  'health',          // basic liveness check, no auth
  'ping',            // synchronous noop, used by tunnel/lifeline probes
  'whoami',          // internal identity probe (sentinel/relay layer 1c)
  'capabilities',    // the discovery endpoint itself — surfacing would recurse
  'internal',        // internal-only IPC namespace
  'pastes',          // internal Claude Code paste-callback receiver
  'listener',        // internal heartbeat/listener wiring
  'events',          // internal SSE/event-stream
  'config',          // global config CRUD used by setup/migrator
  'status',          // legacy status endpoint, superseded by /capabilities
  'shared-state',    // legacy state primitive, superseded by canonicalState
  'backups',         // backup listing is operator-only, not agent-facing
  'episodes',        // legacy episode log, replaced by topicMemory
  'reflection',      // legacy reflection log, replaced by topicMemory
  'serendipity',     // operator review surface, not agent-facing
  'system-review',   // legacy system review log, replaced by responseReview
  'system-reviews',  // legacy system review log, replaced by responseReview
  'systems',         // legacy systems registry, replaced by canonicalState.projects
  'memory',          // deprecated (Deprecation/Sunset headers) → /semantic
  'messaging',       // alternative surface for /telegram, /imessage, etc.
  'messages',        // legacy direct message access
  'providers',       // legacy provider registry, replaced by autonomy
  'quota',           // operator-only quota observability
  'watchdog',        // operator-only watchdog state
  'telemetry',       // operator-only telemetry plumbing
  'homeostasis',     // operator-only homeostasis state
  'agents',          // surfaced via threadline discovery
  'delivery-queue',  // operator-only relay queue observability
  'prompt-gate',     // operator-only prompt-gate observability
  'scope-coherence', // operator-only scope-coherence observability
  'jobs',            // surfaced inside the `scheduler` block
  'slack',           // surfaced via messaging adapters
  'whatsapp',        // surfaced via messaging adapters
  'flows',           // surfaced inside `evolution` subsystems
  'initiatives',     // surfaced inside `evolution` subsystems
  'triage',          // surfaced inside `evolution` subsystems
  'intent',          // surfaced inside `evolution` subsystems
  'self-knowledge',  // surfaced inside `capability-map`
  'capability-map',  // separate self-knowledge surface, has its own discovery path
  'projects',        // surfaced inside `canonicalState`
  'build',           // operator-only build endpoint
  'sessions',        // operator/dashboard-only session listing (no agent-facing API)
];

/**
 * Extract all top-level path prefixes registered on `router.*('/<prefix>...')`.
 * Top-level = the first path segment after the leading slash.
 */
function extractTopLevelPrefixes(source: string): Set<string> {
  const prefixes = new Set<string>();
  const pattern = /router\.(get|post|put|delete|patch)\s*\(\s*['"]\/([a-z][a-z0-9-]*)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    prefixes.add(match[2]);
  }
  return prefixes;
}

/**
 * Extract the literal /capabilities response body — the object passed to
 * `res.json({...})` inside the GET /capabilities handler. Used as the source
 * of truth for what /capabilities surfaces.
 */
function extractCapabilitiesBody(source: string): string {
  const handlerStart = source.indexOf("router.get('/capabilities'");
  if (handlerStart < 0) throw new Error('GET /capabilities handler not found');
  const resJsonStart = source.indexOf('res.json(', handlerStart);
  if (resJsonStart < 0) throw new Error('res.json call not found in /capabilities handler');
  // Walk forward until the matching close paren (depth-1 in res.json call).
  // The body is the {…} between res.json( and the matching ).
  const openBrace = source.indexOf('{', resJsonStart);
  if (openBrace < 0) throw new Error('Opening brace not found in /capabilities res.json');
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(openBrace, i + 1);
    }
  }
  throw new Error('Could not find matching close brace for /capabilities res.json body');
}

describe('Capabilities Discoverability', () => {
  const prefixes = extractTopLevelPrefixes(routesSource);
  const capabilitiesBody = extractCapabilitiesBody(routesSource);

  it('extracts a non-trivial set of route prefixes (sanity)', () => {
    expect(prefixes.size).toBeGreaterThan(30);
  });

  it('Secret Drop (`/secrets`) is surfaced in /capabilities', () => {
    // This is the regression that prompted the lint. It MUST stay green.
    expect(capabilitiesBody).toMatch(/POST \/secrets\/(request|retrieve)/);
  });

  for (const prefix of [...prefixes].sort()) {
    it(`prefix "/${prefix}" is either surfaced in /capabilities or in INTERNAL_ALLOWLIST`, () => {
      if (INTERNAL_ALLOWLIST.includes(prefix)) {
        // Allowlist hit — deliberate skip. Make sure the entry isn't dead by
        // re-confirming the prefix is registered (which we already did when
        // building `prefixes`).
        expect(prefixes.has(prefix)).toBe(true);
        return;
      }
      // Look for the prefix in the /capabilities response body. Three shapes
      // count as "surfaced":
      //   1. An explicit endpoint string ("GET /<prefix>") in any endpoints array
      //   2. A JSON-style key ("<prefix>:") opening a discoverability block
      //   3. ES shorthand reference ("\b<prefix>,") — e.g. `res.json({ telegram, ... })`
      const escaped = prefix.replace(/-/g, '\\-');
      const endpointPattern = new RegExp(
        `(GET|POST|PUT|DELETE|PATCH)\\s+\\/${escaped}(\\b|/)`,
      );
      const keyPattern = new RegExp(`["']?${escaped}["']?\\s*:`);
      const shorthandPattern = new RegExp(`(^|\\s)${escaped}\\s*,`, 'm');
      const surfaced =
        endpointPattern.test(capabilitiesBody) ||
        keyPattern.test(capabilitiesBody) ||
        shorthandPattern.test(capabilitiesBody);

      expect(
        surfaced,
        `Route prefix "/${prefix}" is registered in routes.ts but is NOT surfaced in the /capabilities ` +
          `response and is NOT on the INTERNAL_ALLOWLIST. Either add an endpoint entry inside the appropriate ` +
          `block of res.json({...}) in the GET /capabilities handler, or add "${prefix}" to INTERNAL_ALLOWLIST ` +
          `in tests/unit/capabilities-discoverability.test.ts with a one-line reason.`,
      ).toBe(true);
    });
  }
});
