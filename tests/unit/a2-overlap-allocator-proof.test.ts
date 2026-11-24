import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Connection = InstanceType<typeof Database>;
type Allocation = { scope: string; epoch: number };
type Claim = { id: string; fact: string; expected: Allocation | null; successor: Allocation; extraFact?: string };
type ClaimResult = 'accepted' | 'overlap' | 'handover-pending';

describe('A2 allocation contract with a disposable SQLite owner', () => {
  let directory: string;
  let file: string;
  let owner: Connection;
  let contender: Connection;
  const connections: Connection[] = [];

  function open(): Connection {
    const connection = new Database(file);
    connections.push(connection);
    return connection;
  }

  function allocation(connection: Connection, fact: string): Allocation | null {
    return connection.prepare('SELECT scope, epoch FROM allocation WHERE fact = ?').get(fact) as Allocation | undefined ?? null;
  }

  function accept(connection: Connection, claim: Claim, fault?: () => void): ClaimResult {
    return connection.transaction((): ClaimResult => {
      if (connection.prepare('SELECT 1 FROM receipt WHERE id = ?').get(claim.id)) return 'accepted';
      const current = allocation(connection, claim.fact);
      if (current?.scope !== claim.expected?.scope || current?.epoch !== claim.expected?.epoch) return 'overlap';
      if (claim.extraFact && allocation(connection, claim.extraFact)) return 'overlap';
      if (current && connection.prepare(`
        SELECT 1 FROM writer
        WHERE scope = ? AND epoch = ? AND (sealed = 0 OR carried < accepted)
      `).get(current.scope, current.epoch)) return 'handover-pending';
      connection.prepare(`
        INSERT INTO allocation VALUES (?, ?, ?)
        ON CONFLICT(fact) DO UPDATE SET scope = excluded.scope, epoch = excluded.epoch
      `).run(claim.fact, claim.successor.scope, claim.successor.epoch);
      if (claim.extraFact) {
        connection.prepare('INSERT INTO allocation VALUES (?, ?, ?)').run(
          claim.extraFact, claim.successor.scope, claim.successor.epoch,
        );
      }
      fault?.();
      connection.prepare('INSERT INTO receipt VALUES (?)').run(claim.id);
      return 'accepted';
    }).immediate();
  }

  function write(connection: Connection, fact: string, checked: Allocation, writer: string, operation: string): boolean {
    return connection.transaction(() => {
      const current = allocation(connection, fact);
      if (current?.scope !== checked.scope || current.epoch !== checked.epoch) return false;
      const enrolled = connection.prepare(
        'SELECT 1 FROM writer WHERE scope = ? AND epoch = ? AND id = ? AND sealed = 0',
      ).get(checked.scope, checked.epoch, writer);
      if (!enrolled) return false;

      const effect = connection.prepare('INSERT OR IGNORE INTO effect VALUES (?, ?)').run(fact, operation);
      if (effect.changes) {
        connection.prepare(
          'UPDATE writer SET accepted = accepted + 1 WHERE scope = ? AND epoch = ? AND id = ?',
        ).run(checked.scope, checked.epoch, writer);
      }
      return true;
    }).immediate();
  }

  const retiring = { scope: 'parent', epoch: 1 };
  const successor = { scope: 'child', epoch: 2 };
  const split: Claim = { id: 'split', fact: 'record', expected: retiring, successor, extraFact: 'overlap' };
  const bootstrap: Claim = {
    id: 'bootstrap', fact: 'overlap', expected: null, successor: { scope: 'bootstrap', epoch: 1 },
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'instar-a2-overlap-'));
    file = join(directory, 'owner.sqlite');
    owner = open();
    owner.pragma('journal_mode = WAL');
    owner.exec(`
      CREATE TABLE allocation (fact TEXT PRIMARY KEY, scope TEXT NOT NULL, epoch INTEGER NOT NULL);
      CREATE TABLE receipt (id TEXT PRIMARY KEY);
      CREATE TABLE writer (
        scope TEXT NOT NULL, epoch INTEGER NOT NULL, id TEXT NOT NULL,
        sealed INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 0,
        carried INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, epoch, id)
      );
      CREATE TABLE effect (fact TEXT NOT NULL, operation TEXT NOT NULL, PRIMARY KEY (fact, operation));
      INSERT INTO allocation VALUES ('record', 'parent', 1), ('unmoved', 'parent', 1);
      INSERT INTO writer (scope, epoch, id) VALUES
        ('parent', 1, 'first'), ('parent', 1, 'isolated'), ('child', 2, 'successor'), ('bootstrap', 1, 'rival');
    `);
    contender = open();
  });

  afterEach(() => {
    for (const connection of connections.splice(0)) if (connection.open) connection.close();
    SafeFsExecutor.safeRmSync(directory, {
      recursive: true, force: true, operation: 'a2-overlap-allocator-proof.test.ts:cleanup',
    });
  });

  it('arbitrates overlapping bootstrap and split in one durable transaction', () => {
    expect(allocation(owner, 'record')).toEqual(retiring);
    expect(allocation(owner, 'overlap')).toBeNull();
    expect(allocation(contender, 'overlap')).toBeNull();
    owner.exec("UPDATE writer SET sealed = 1 WHERE scope = 'parent'");

    expect(() => accept(owner, split, () => { throw new Error('interrupted before receipt'); })).toThrow('interrupted');
    expect(allocation(contender, 'record')).toEqual(retiring);
    expect(allocation(contender, 'overlap')).toBeNull();
    expect(accept(owner, split)).toBe('accepted'); // Drop the reply and reconnect to the durable owner.
    owner.close();
    contender.close();

    const recovered = open();
    expect(accept(recovered, split)).toBe('accepted');
    expect(accept(recovered, bootstrap)).toBe('overlap');
    expect(write(recovered, 'overlap', bootstrap.successor, 'rival', 'rejected')).toBe(false);
    expect(write(recovered, 'record', successor, 'successor', 'winner')).toBe(true);
    expect(allocation(recovered, 'unmoved')).toEqual(retiring);
    expect(accept(recovered, { ...bootstrap, id: 'disjoint', fact: 'disjoint' })).toBe('accepted');

    const rivalFirst = { ...bootstrap, id: 'rival-first', fact: 'second-overlap' };
    expect(allocation(recovered, 'second-overlap')).toBeNull();
    expect(accept(recovered, rivalFirst)).toBe('accepted');
    expect(accept(recovered, {
      ...split, id: 'second-split', fact: 'unmoved', extraFact: 'second-overlap',
    })).toBe('overlap');
    expect(allocation(recovered, 'unmoved')).toEqual(retiring);
    expect(write(recovered, 'second-overlap', rivalFirst.successor, 'rival', 'rival-won')).toBe(true);
  });

  it('rejects a paused writer at acceptance and carries forward an accepted operation once', () => {
    const checked = allocation(contender, 'record')!;
    expect(checked).toEqual(retiring);
    expect(write(contender, 'record', checked, 'first', 'before-transfer')).toBe(true);

    owner.exec("UPDATE writer SET sealed = 1, carried = accepted WHERE scope = 'parent'");
    expect(accept(owner, split)).toBe('accepted');

    expect(write(contender, 'record', checked, 'first', 'stale')).toBe(false);
    expect(write(contender, 'record', successor, 'successor', 'before-transfer')).toBe(true);
    expect(write(contender, 'record', successor, 'successor', 'retry')).toBe(true);
    expect(write(contender, 'record', successor, 'successor', 'retry')).toBe(true);
    expect(owner.prepare('SELECT operation FROM effect ORDER BY operation').pluck().all()).toEqual(['before-transfer', 'retry']);
  });

  it('holds handover until a formerly authorized isolated writer is sealed and its last state carried', () => {
    expect(write(contender, 'record', retiring, 'isolated', 'last-old-write')).toBe(true);
    contender.close(); // The coordinator loses access to this writer before it can obtain closure.
    owner.exec("UPDATE writer SET sealed = 1 WHERE id = 'first'");
    expect(accept(owner, split)).toBe('handover-pending');
    expect(write(owner, 'record', successor, 'successor', 'too-early')).toBe(false);

    owner.exec("UPDATE writer SET sealed = 1 WHERE id = 'isolated'");
    expect(accept(owner, split)).toBe('handover-pending');
    owner.exec("UPDATE writer SET carried = accepted WHERE id = 'isolated'");
    expect(accept(owner, split)).toBe('accepted');
    expect(write(open(), 'record', retiring, 'isolated', 'late-old-write')).toBe(false);
    expect(owner.prepare('SELECT operation FROM effect').pluck().all()).toEqual(['last-old-write']);
  });
});
