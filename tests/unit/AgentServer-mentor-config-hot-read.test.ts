import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readMentorConfigFromDisk } from '../../src/server/AgentServer.js';
import { DEFAULT_MENTOR_CONFIG, type MentorConfig } from '../../src/scheduler/MentorOnboardingRunner.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('readMentorConfigFromDisk', () => {
  let dir: string;
  let stateDir: string;
  let fallback: MentorConfig;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-config-hot-read-unit-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fallback = {
      ...DEFAULT_MENTOR_CONFIG,
      enabled: true,
      mode: 'dry-run',
      onboardingAgenda: ['startup agenda'],
      minIntervalMs: 123,
    };
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/AgentServer-mentor-config-hot-read.test.ts' });
  });

  it('picks up a changed on-disk mentor agenda on the next read', () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      mentor: {
        enabled: true,
        mode: 'live',
        onboardingAgenda: ['updated agenda'],
        minIntervalMs: 456,
      },
    }));

    expect(readMentorConfigFromDisk(stateDir, fallback)).toMatchObject({
      enabled: true,
      mode: 'live',
      onboardingAgenda: ['updated agenda'],
      minIntervalMs: 456,
      menteeFramework: 'codex-cli',
    });

    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      mentor: {
        enabled: true,
        mode: 'live',
        onboardingAgenda: ['second agenda'],
        minIntervalMs: 789,
      },
    }));

    expect(readMentorConfigFromDisk(stateDir, fallback)).toMatchObject({
      onboardingAgenda: ['second agenda'],
      minIntervalMs: 789,
    });
  });

  it('falls back to the startup mentor config when config cannot be parsed', () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{not valid json');

    expect(readMentorConfigFromDisk(stateDir, fallback)).toEqual(fallback);
  });

  it('falls back to the startup mentor config when the mentor block has a bad shape', () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ mentor: ['bad'] }));

    expect(readMentorConfigFromDisk(stateDir, fallback)).toEqual(fallback);
  });
});
