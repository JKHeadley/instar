import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runFeedbackFactoryDefaultsSelfHeal } from '../../src/feedback-factory/drain/FeedbackFactoryDefaultsSelfHeal.js';
import { inspectFeedbackFactoryGeneratedDefaults } from '../../src/feedback-factory/drain/FeedbackFactoryGeneratedDefaults.js';
import { initSelfActionGovernor } from '../../src/monitoring/selfaction/governor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-e2e-'));
afterAll(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'self-heal-gate-alive cleanup' }));

describe('SelfHealGate first application is alive', () => {
  it('repairs on boot one and verifies only on boot two', async () => {
    initSelfActionGovernor({ stateDir, readEmergencyDisable: () => false, readClassesConfig: () => ({}), now: () => Date.now(), flushIntervalMs: 60_000 });
    const notify = vi.fn();
    const first = await runFeedbackFactoryDefaultsSelfHeal({ stateDir, developmentAgent: true, bootId: 'boot-one', currentFence: () => 'machine-a:1', notify });
    expect(first).toMatchObject({ attempted: true, outcome: 'attempted' });
    expect(inspectFeedbackFactoryGeneratedDefaults(stateDir, true).posture).toBe('healthy');
    const requestPath = path.join(stateDir, 'state', 'restart-requested.json');
    expect(fs.existsSync(requestPath)).toBe(true);

    SafeFsExecutor.safeUnlinkSync(requestPath, { operation: 'self-heal-gate-alive simulate supervisor consume' });
    const second = await runFeedbackFactoryDefaultsSelfHeal({ stateDir, developmentAgent: true, bootId: 'boot-two', currentFence: () => 'machine-a:1', notify });
    expect(second).toMatchObject({ attempted: true, outcome: 'healed' });
    expect(fs.existsSync(requestPath)).toBe(false);

    const third = await runFeedbackFactoryDefaultsSelfHeal({ stateDir, developmentAgent: true, bootId: 'boot-three', currentFence: () => 'machine-a:1', notify });
    expect(third).toEqual({ attempted: false, outcome: 'healthy' });
    expect(notify).not.toHaveBeenCalled();
  });
});
