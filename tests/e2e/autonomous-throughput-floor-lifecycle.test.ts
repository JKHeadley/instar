import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { SELF_ACTION_CONTROLLERS } from '../../src/testing/selfActionRegistry.js';
import { GOVERNOR_DEFAULT_POLICIES } from '../../src/monitoring/selfaction/policies.js';

describe('Autonomous Throughput Floor lifecycle', () => {
  it('ships dark with no notification or self-action controller', () => {
    expect(DEV_GATED_FEATURES.find(f => f.name === 'autonomousThroughputFloor')?.configPath).toBe('monitoring.throughputFloor.enabled');
    expect(SELF_ACTION_CONTROLLERS.some(c => c.id.includes('throughput-floor'))).toBe(false);
    expect(GOVERNOR_DEFAULT_POLICIES.some(p => p.controllerId.includes('throughput-floor'))).toBe(false);
    const source = fs.readFileSync(new URL('../../src/monitoring/AutonomousThroughputFloor.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/redispatch\(|notify\(|createAttention|sendAuto/);
  });
});
