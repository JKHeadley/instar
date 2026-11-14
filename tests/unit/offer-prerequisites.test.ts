import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  isBlankAgentHome,
  isMigrationComplete,
  markMigrationComplete,
  markNewAgent,
  offerPrerequisitesDir,
  readDeliveredFirstResult,
  recordDeliveredFirstResult,
} from '../../src/recommended/offerPrerequisites.js';

describe('offer prerequisites', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-prereq-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/offer-prerequisites cleanup' }));

  const damage = (name: string) => {
    fs.mkdirSync(offerPrerequisitesDir(dir), { recursive: true });
    fs.writeFileSync(path.join(offerPrerequisitesDir(dir), name), 'not json');
  };

  describe('migration flag', () => {
    it('is off until marked, and belongs to one owner', () => {
      expect(isMigrationComplete(dir, 'owner-a')).toBe(false);
      markMigrationComplete(dir, 'owner-a');
      expect(isMigrationComplete(dir, 'owner-a')).toBe(true);
      expect(isMigrationComplete(dir)).toBe(false);
      expect(isMigrationComplete(dir, 'owner-b')).toBe(false);
      markMigrationComplete(dir, 'owner-b');
      expect(isMigrationComplete(dir, 'owner-a')).toBe(true);
      expect(isMigrationComplete(dir, 'owner-b')).toBe(true);
    });

    it('reads a damaged file as not yet, and an inherited name is no owner', () => {
      damage('migration-complete.json');
      expect(isMigrationComplete(dir, 'owner-a')).toBe(false);
      markMigrationComplete(dir, 'owner-a');
      expect(isMigrationComplete(dir, 'constructor')).toBe(false);
    });

    it('a new agent is ready for every owner, whatever form the id takes', () => {
      markNewAgent(dir);
      expect(isMigrationComplete(dir)).toBe(true);
      expect(isMigrationComplete(dir, '7812716706')).toBe(true);
    });

    it('marking one does not lose the other', () => {
      markMigrationComplete(dir, 'owner-a');
      markNewAgent(dir);
      const stored = JSON.parse(fs.readFileSync(path.join(offerPrerequisitesDir(dir), 'migration-complete.json'), 'utf-8'));
      expect(Object.keys(stored.owners)).toEqual(['owner-a']);
      expect(stored.newAgentAt).toBeTypeOf('string');
    });

    it.each(['config.json', 'AGENT.md', 'soul.md'])('a home holding %s is not blank', (file) => {
      expect(isBlankAgentHome(dir)).toBe(true);
      fs.writeFileSync(path.join(dir, file), 'x');
      expect(isBlankAgentHome(dir)).toBe(false);
    });

    it('keeps the first time when marked again', () => {
      markMigrationComplete(dir, 'default', () => new Date('2026-01-01T00:00:00Z'));
      markMigrationComplete(dir, 'default', () => new Date('2026-02-02T00:00:00Z'));
      const stored = JSON.parse(fs.readFileSync(path.join(offerPrerequisitesDir(dir), 'migration-complete.json'), 'utf-8'));
      expect(stored.owners.default.at).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('first result', () => {
    it('keeps the earliest delivered result', () => {
      expect(readDeliveredFirstResult(dir)).toBeNull();
      expect(recordDeliveredFirstResult(dir, 'telegram', 41)).toBe(true);
      expect(recordDeliveredFirstResult(dir, 'slack', '170.1')).toBe(false);
      expect(readDeliveredFirstResult(dir)).toMatchObject({ carrier: 'telegram', messageId: '41' });
    });

    it.each([[null], [undefined], [''], [0]])('records nothing with no real message id: %s', (id) => {
      expect(recordDeliveredFirstResult(dir, 'telegram', id)).toBe(false);
      expect(readDeliveredFirstResult(dir)).toBeNull();
    });

    it('reads a damaged file as not yet, and a later delivery repairs it', () => {
      damage('first-result.json');
      expect(readDeliveredFirstResult(dir)).toBeNull();
      expect(recordDeliveredFirstResult(dir, 'slack', '170.1')).toBe(true);
      expect(readDeliveredFirstResult(dir)?.carrier).toBe('slack');
    });
  });
});
