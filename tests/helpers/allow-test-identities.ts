/**
 * Test-only helper for the silent-loss-refusal-conservation fixture-identity gate.
 *
 * Production refuses known test/fixture identities (u-olivia, U_MIA, livetest-*, …)
 * from the real user registry at both the write and load layers (spec §2.D). Tests
 * that LEGITIMATELY register such fixtures use the intended DOUBLE-KEYED escape:
 *   (1) the env flag `INSTAR_ALLOW_TEST_IDENTITIES=1`, AND
 *   (2) an on-disk `.instar-test-home` marker inside the state dir.
 * Both keys are required by construction — a stray env var alone can never disable
 * the production guard. This helper sets both for a given throwaway test state dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TEST_HOME_MARKER_FILENAME } from '../../src/users/testIdentityMarkers.js';

export function allowTestIdentities(stateDir: string): void {
  process.env.INSTAR_ALLOW_TEST_IDENTITIES = '1';
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, TEST_HOME_MARKER_FILENAME), '');
}
