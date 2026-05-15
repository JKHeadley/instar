/**
 * Codex session-layout canary.
 *
 * Verifies that the assumption "Codex writes rollouts to $CODEX_HOME/
 * sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl" still holds. If a future
 * Codex CLI version changes the layout (flatter or differently-named),
 * conversationLogReader / Tailer / sessionResumeIndex would silently
 * return empty results. The canary catches that drift.
 *
 * Method: write a synthetic rollout under a temp $CODEX_HOME, walk the
 * tree with findRolloutFile, assert it's discoverable. Self-healing
 * for layout changes is NOT applicable — a layout change is a code-fix
 * surface, not a runtime-recover one.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (degraded triage, resume index, conversation log readers)
 *   Frequency:   startup canary (one tick per adapter construction)
 *   Stability:   semi-stable (Codex changes layout occasionally — yearly cadence)
 *   Fallback:    none for layout change; degrades to empty reads + alert
 *   Verdict:     deterministic synthetic-fixture walk; no LLM fallback needed
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findRolloutFile, listAllRollouts } from '../observability/sessionPaths.js';

export interface CodexSessionLayoutCanaryResult {
  status: 'pass' | 'fail';
  message: string;
  details: {
    rolloutFoundByUuid: boolean;
    listFoundFixture: boolean;
    walkRespectedDateParts: boolean;
  };
}

/**
 * Run the canary. Synchronously creates a temp $CODEX_HOME with a known
 * rollout file, runs findRolloutFile and listAllRollouts against it, and
 * verifies the layout helpers find the fixture.
 */
export async function runCodexSessionLayoutCanary(): Promise<CodexSessionLayoutCanaryResult> {
  const fakeHome = path.join(tmpdir(), `codex-canary-${randomBytes(8).toString('hex')}`);
  const yyyy = '2026';
  const mm = '05';
  const dd = '15';
  const fixtureUuid = `019e2d73-aaaa-7000-9999-${randomBytes(6).toString('hex')}`;
  const fixtureDir = path.join(fakeHome, 'sessions', yyyy, mm, dd);
  const fixturePath = path.join(fixtureDir, `rollout-1747280000-${fixtureUuid}.jsonl`);

  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(fixturePath, '{"type":"thread.started","thread_id":"' + fixtureUuid + '"}\n', 'utf-8');

  try {
    const found = await findRolloutFile(fixtureUuid, fakeHome);
    const list = await listAllRollouts(fakeHome, 5);
    const rolloutFoundByUuid = found === fixturePath;
    const listFoundFixture = list.some((r) => r.path === fixturePath);
    const walkRespectedDateParts = found?.includes(`/${yyyy}/${mm}/${dd}/`) ?? false;

    const allPass = rolloutFoundByUuid && listFoundFixture && walkRespectedDateParts;
    return {
      status: allPass ? 'pass' : 'fail',
      message: allPass
        ? 'codex session-layout canary: rollout discovery intact'
        : `codex session-layout canary: discovery FAILED (byUuid=${rolloutFoundByUuid}, list=${listFoundFixture}, dateParts=${walkRespectedDateParts})`,
      details: { rolloutFoundByUuid, listFoundFixture, walkRespectedDateParts },
    };
  } finally {
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
  }
}
