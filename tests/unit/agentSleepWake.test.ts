/**
 * Unit tests — agent hard-sleep wake-trigger helper (the lifeline side of the
 * stop+wake handshake). Both sides: marker present → wake-request written; marker
 * absent → no-op (steady-state awake never writes).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { writeWakeRequestIfSlept } from '../../src/lifeline/agentSleepWake.js';

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-helper-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

describe('writeWakeRequestIfSlept', () => {
  it('no-op when the server is NOT asleep (no slept-marker)', () => {
    const dir = tmp();
    try {
      expect(writeWakeRequestIfSlept(dir, new Date().toISOString())).toBe(false);
      expect(fs.existsSync(path.join(dir, 'state', 'wake-requested.json'))).toBe(false);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); }
  });

  it('writes wake-requested.json when a slept-marker is present', () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, 'state', 'slept-marker.json'), JSON.stringify({ sleptAt: new Date().toISOString() }));
      const iso = new Date().toISOString();
      expect(writeWakeRequestIfSlept(dir, iso)).toBe(true);
      const p = path.join(dir, 'state', 'wake-requested.json');
      expect(fs.existsSync(p)).toBe(true);
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      expect(data.requestedBy).toBe('TelegramLifeline');
      expect(data.requestedAt).toBe(iso);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); }
  });
});
