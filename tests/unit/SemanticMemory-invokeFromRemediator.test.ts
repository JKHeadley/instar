// safe-git-allow: test file — uses SafeFsExecutor.safeRmSync; raw fs.* only for setup.
/**
 * Tests for SemanticMemory.invokeFromRemediator — the W-4 surface entry
 * point that the db-corruption runbook surfaceCallable invokes.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A3 (HMAC), §A4 (abort), §A9
 * (durability assertion / db.mode), §A34 (surface alignment), §A57 (Tier-2).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  SemanticMemory,
  type SemanticMemoryRemediatorContext,
  type SemanticMemoryCapabilityLeafKeyVault,
} from '../../src/memory/SemanticMemory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Fixture {
  dir: string;
  dbPath: string;
  jsonlPath: string;
  memory: SemanticMemory;
  cleanup: () => void;
}

async function makeFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4-sm-invoke-'));
  const dbPath = path.join(dir, 'semantic.db');
  const jsonlPath = dbPath.replace(/\.db$/, '.jsonl');
  const memory = new SemanticMemory({
    dbPath,
    staleThreshold: 0.3,
    confidenceDecayRate: 0.01,
    autoRebuildMaxBytes: 50 * 1024 * 1024,
  });
  await memory.open();
  SemanticMemory.setActiveInstance(memory);
  return {
    dir,
    dbPath,
    jsonlPath,
    memory,
    cleanup: () => {
      try {
        memory.close();
      } catch {
        /* ignore */
      }
      SemanticMemory.resetForTesting();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/SemanticMemory-invokeFromRemediator.test.ts:cleanup',
      });
    },
  };
}

function makeCtx(
  overrides?: Partial<SemanticMemoryRemediatorContext>,
): SemanticMemoryRemediatorContext {
  return {
    attemptId: overrides?.attemptId ?? 'test-attempt',
    runbookId: overrides?.runbookId ?? 'db-corruption',
    auditToken: overrides?.auditToken ?? Buffer.from('test-audit'),
    abortSignal: overrides?.abortSignal ?? new AbortController().signal,
    expiresAt: overrides?.expiresAt ?? Date.now() + 60_000,
    monotonicDeadline:
      overrides?.monotonicDeadline ?? process.hrtime.bigint() + 60_000_000_000n,
    hmac: overrides?.hmac,
    lockHandle: overrides?.lockHandle ?? {},
  };
}

function writeGarbage(dbPath: string): void {
  fs.writeFileSync(dbPath, 'not a sqlite db — garbage bytes for W-4 test');
}

function canonicalCtxBody(
  ctx: Pick<
    SemanticMemoryRemediatorContext,
    'attemptId' | 'runbookId' | 'expiresAt' | 'monotonicDeadline'
  >,
): Buffer {
  const HMAC_TAG = Buffer.from('instar-f8-ctx-v1\x00', 'utf-8');
  const writeStr = (s: string): Buffer => {
    const body = Buffer.from(s, 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  };
  const expiresAtBuf = Buffer.alloc(8);
  expiresAtBuf.writeBigUInt64BE(
    BigInt(Math.max(0, Math.floor(ctx.expiresAt))),
    0,
  );
  const monoBuf = Buffer.alloc(8);
  monoBuf.writeBigUInt64BE(ctx.monotonicDeadline, 0);
  return Buffer.concat([
    HMAC_TAG,
    writeStr(ctx.attemptId),
    writeStr(ctx.runbookId),
    expiresAtBuf,
    monoBuf,
  ]);
}

class FakeKeyVault implements SemanticMemoryCapabilityLeafKeyVault {
  private readonly key = crypto.randomBytes(32);
  deriveLeafKey(_context: 'capability', scopeId: string): Buffer {
    // Different scopes get different leaves so cross-runbook forgery is prevented.
    return crypto
      .createHmac('sha256', this.key)
      .update(`cap:${scopeId}`)
      .digest();
  }
  sign(ctx: SemanticMemoryRemediatorContext): Buffer {
    const leaf = this.deriveLeafKey('capability', ctx.runbookId);
    return crypto.createHmac('sha256', leaf).update(canonicalCtxBody(ctx)).digest();
  }
}

describe('SemanticMemory.invokeFromRemediator (W-4 §A57)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('returns failure with reason=no-active-instance when no instance is registered', async () => {
    SemanticMemory.setActiveInstance(null);
    const result = await SemanticMemory.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('no-active-instance');
  });

  it('returns failure with reason=aborted-before-start when ctx is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await SemanticMemory.invokeFromRemediator(
      makeCtx({ abortSignal: ac.signal }),
    );
    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('aborted-before-start');
  });

  it('succeeds on a healthy db (no rebuild ran)', async () => {
    const result = await SemanticMemory.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('success');
    expect(result.details.rebuiltFromJsonl).toBe(false);
    expect(result.details.integrityValue).toBe('ok');
    expect(result.details.dbPath).toBe(fx.dbPath);
  });

  it('detects corruption, quarantines, rebuilds from JSONL, and reports rebuiltFromJsonl=true', async () => {
    // Remember something so the JSONL has content.
    fx.memory.remember({
      type: 'fact',
      name: 'recovery anchor',
      content: 'used by the W-4 test to verify JSONL rebuild path',
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      tags: [],
      source: 'session',
    });
    // Force JSONL flush by closing.
    fx.memory.close();

    // Corrupt the db file on disk.
    writeGarbage(fx.dbPath);

    const result = await SemanticMemory.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('success');
    expect(result.details.rebuiltFromJsonl).toBe(true);
    expect(result.details.integrityValue).toBe('ok');

    // The corrupt file should have been quarantined (renamed to .corrupt.<ts>).
    const entries = fs.readdirSync(fx.dir);
    expect(entries.some((e) => e.includes('.corrupt.'))).toBe(true);
    expect(entries.some((e) => e.includes('corrupt-recovery'))).toBe(true);
  });

  it('rejects calls with an invalid HMAC when a keyVault is wired (§A3)', async () => {
    const vault = new FakeKeyVault();
    SemanticMemory.setRemediatorKeyVault(vault);

    const ctx = makeCtx({ hmac: Buffer.from('totally-bogus-signature') });
    const result = await SemanticMemory.invokeFromRemediator(ctx);
    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('invalid-context');
  });

  it('accepts calls with a valid HMAC (§A3)', async () => {
    const vault = new FakeKeyVault();
    SemanticMemory.setRemediatorKeyVault(vault);

    const ctx = makeCtx();
    ctx.hmac = vault.sign(ctx);
    const result = await SemanticMemory.invokeFromRemediator(ctx);
    expect(result.outcome).toBe('success');
    expect(result.details.hmacVerified).toBe('verified');
  });

  it('records hmacVerified=unverified-no-vault when no keyVault is wired', async () => {
    SemanticMemory.setRemediatorKeyVault(null);
    const result = await SemanticMemory.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('success');
    expect(result.details.hmacVerified).toBe('unverified-no-vault');
  });

  it('getDurabilityMode returns "durable" for an on-disk db', () => {
    expect(fx.memory.getDurabilityMode()).toBe('durable');
  });

  it('getDurabilityMode returns "closed" after close()', () => {
    fx.memory.close();
    expect(fx.memory.getDurabilityMode()).toBe('closed');
  });

  it('runIntegrityCheckForRemediator returns "ok" on a healthy db', () => {
    expect(fx.memory.runIntegrityCheckForRemediator()).toBe('ok');
  });

  it('runIntegrityCheckForRemediator throws when db is closed (mapped to verify-inconclusive by runbook)', () => {
    fx.memory.close();
    expect(() => fx.memory.runIntegrityCheckForRemediator()).toThrow(
      /closed/i,
    );
  });

  it('registerInstance / unregisterInstance are inverse', () => {
    SemanticMemory.unregisterInstance(fx.memory);
    expect(SemanticMemory.getActiveInstanceForRemediator()).toBeNull();
    SemanticMemory.registerInstance(fx.memory);
    SemanticMemory.setActiveInstance(fx.memory);
    expect(SemanticMemory.getActiveInstanceForRemediator()).toBe(fx.memory);
  });
});
