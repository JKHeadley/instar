/**
 * Mint-idiom grep ratchet (spec durable-conversation-identity §10 wiring
 * integrity): the mint idiom `-(Math.abs(<hash>) + 1)` may exist ONLY in the
 * consolidated module plus the KNOWN legacy copies awaiting the §4
 * consolidation. A FOURTH copy is a CI failure — the registry exists
 * precisely because the hash was triplicated and drifted (§1).
 *
 * Deliberately scoped to the MINT idiom, NOT the bare `(hash << 5) - hash`
 * literal (which also appears in TelegraphService for unrelated
 * change-detection — security-m1).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** The §3.3 mint idiom: a negated Math.abs(...) + 1 (one nesting level tolerated). */
const MINT_IDIOM = /-\s*\(\s*Math\.abs\((?:[^()]|\([^()]*\))*\)\s*\+\s*1\s*\)/;

/**
 * The allowlist: the ONE consolidated surface + the legacy copies §4 retires.
 * Removing entries here (as consolidation lands) is fine; ADDING one is a
 * design decision that must go through the spec.
 */
const ALLOWED = new Set([
  'core/conversationIdentity.ts',
  'core/slackRefreshBinding.ts',
  'commands/server.ts',
  'server/routes.ts',
]);

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

describe('conversation-identity mint-idiom ratchet (§10)', () => {
  it('the mint idiom -(Math.abs(…) + 1) appears ONLY in the allowlisted files', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (MINT_IDIOM.test(content)) offenders.push(rel);
    }
    expect(
      offenders,
      `A NEW copy of the mint idiom was introduced outside the consolidated surface. ` +
        `Use candidateIdForRoutingKey from src/core/conversationIdentity.ts instead. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the consolidated module itself carries the idiom (the ratchet is testing the right pattern)', () => {
    const content = fs.readFileSync(path.join(SRC_ROOT, 'core/conversationIdentity.ts'), 'utf-8');
    expect(MINT_IDIOM.test(content)).toBe(true);
  });
});
