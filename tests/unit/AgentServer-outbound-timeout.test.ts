/**
 * Wiring-integrity guard: the server's per-path request-timeout overrides must
 * route LLM-backed / third-party routes to their extended budgets — and the
 * fast sibling routes must stay on the default.
 *
 * This asserts against the PRODUCTION map (`buildRequestTimeoutOverrides()`) and
 * the PRODUCTION matcher (`resolveRequestTimeout()`) imported directly — not a
 * source regex and not a hand-rolled copy. A hand-rolled map would let this pass
 * while the server is misconfigured; importing the real functions closes that
 * dead-code/false-wiring trap (PR-#334 lesson). AgentServer wires these exact
 * functions, so a regression in the map or the matcher fails here.
 *
 * Background: the duplicate-outbound-message bug (30s 408 on LLM-backed outbound
 * routes), and the conformance-gate timeout fix (docs/specs/conformance-gate-timeout.md)
 * where /spec/conformance-check inherited the 30s default and 408'd on real specs.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildRequestTimeoutOverrides,
  resolveRequestTimeout,
  OUTBOUND_MESSAGING_TIMEOUT_MS,
  SPEC_REVIEW_TIMEOUT_MS,
} from '../../src/server/middleware.js';
import { CONFORMANCE_REVIEW_TIMEOUT_MS } from '../../src/core/reviewers/standards-conformance.js';

const DEFAULT_MS = 30_000;

describe('request-timeout override map (production wiring)', () => {
  const overrides = buildRequestTimeoutOverrides();

  const outboundPrefixes = [
    '/telegram/reply',
    '/telegram/post-update',
    '/slack/reply',
    '/whatsapp/send',
    '/imessage/reply',
    '/imessage/validate-send',
  ];

  for (const prefix of outboundPrefixes) {
    it(`resolves ${prefix} to the outbound-messaging budget`, () => {
      expect(resolveRequestTimeout(prefix, DEFAULT_MS, overrides)).toBe(OUTBOUND_MESSAGING_TIMEOUT_MS);
    });
  }

  it('resolves /spec/conformance-check to the spec-review budget (the bug this fixed)', () => {
    expect(resolveRequestTimeout('/spec/conformance-check', DEFAULT_MS, overrides)).toBe(SPEC_REVIEW_TIMEOUT_MS);
  });

  it('leaves the fast sibling /spec/conformance-metrics on the default (no over-reach)', () => {
    // It is a sibling, NOT a child of /spec/conformance-check, so longest-prefix
    // matching must not catch it.
    expect(resolveRequestTimeout('/spec/conformance-metrics', DEFAULT_MS, overrides)).toBe(DEFAULT_MS);
  });

  it('leaves an arbitrary unrelated route on the default', () => {
    expect(resolveRequestTimeout('/health', DEFAULT_MS, overrides)).toBe(DEFAULT_MS);
    expect(resolveRequestTimeout('/telegram/reply-but-different', DEFAULT_MS, overrides)).toBe(DEFAULT_MS);
  });

  it('uses budgets materially larger than the 30s default', () => {
    expect(OUTBOUND_MESSAGING_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
    expect(SPEC_REVIEW_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
  });

  it('orders the inner provider budget strictly below the outer HTTP budget', () => {
    // The provider must kill a too-slow review cleanly (fail-open degraded
    // report) BEFORE the middleware fires a 408 at the client. If this inverts,
    // a slow spec produces a raw 408 again.
    expect(CONFORMANCE_REVIEW_TIMEOUT_MS).toBeLessThan(SPEC_REVIEW_TIMEOUT_MS);
  });

  it('AgentServer wires the production override builder (not an inline literal)', () => {
    const agentServerSrc = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/server/AgentServer.ts'),
      'utf-8',
    );
    // Regression guard: the global default is still passed as the first arg, and
    // the overrides come from the shared builder (so this test's map == prod's).
    expect(agentServerSrc).toMatch(/requestTimeout\(options\.config\.requestTimeoutMs,\s*buildRequestTimeoutOverrides\(\)\)/);
  });
});

describe('init.ts relay installers read from canonical templates (no inlined drift)', () => {
  const initSource = fs.readFileSync(
    path.join(import.meta.dirname, '../../src/commands/init.ts'),
    'utf-8',
  );

  it('installTelegramRelay uses loadRelayTemplate (not inlined bash)', () => {
    // Extract the function body and assert it delegates to loadRelayTemplate.
    // Prevents regression back to the old 70+ line inlined bash that went
    // out of sync with src/templates/scripts/telegram-reply.sh.
    const fnMatch = initSource.match(/function installTelegramRelay\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toContain("loadRelayTemplate('telegram-reply.sh'");
    // Sanity: it must NOT contain the old inlined 200-branch echo, which
    // would indicate a partial revert.
    expect(fnMatch![0]).not.toMatch(/echo "Sent \$\(echo "\$MSG"/);
  });

  it('installWhatsAppRelay uses loadRelayTemplate (not inlined bash)', () => {
    const fnMatch = initSource.match(/function installWhatsAppRelay\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toContain("loadRelayTemplate('whatsapp-reply.sh'");
    expect(fnMatch![0]).not.toMatch(/echo "Sent \$\(echo "\$MSG"/);
  });

  it('loadRelayTemplate substitutes INSTAR_PORT default with the agent port', () => {
    const fnMatch = initSource.match(/function loadRelayTemplate\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toMatch(/INSTAR_PORT:-4040/);
    expect(fnMatch![0]).toMatch(/INSTAR_PORT:-\$\{port\}/);
  });
});
