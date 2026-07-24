import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCapacityEnforcementContracts } from '../../scripts/lint-expected-capacity-degradations.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('capacity enforcement contract lint', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'capacity contract lint cleanup' });
  });

  function fixture(source: string, contract: Record<string, unknown>, registry: Record<string, unknown> = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-contract-lint-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'Store.ts'), source);
    fs.writeFileSync(path.join(root, 'docs', 'capacity-enforcement-contracts.json'), JSON.stringify({ version: 1, contracts: [contract], retiredContracts: [], ...registry }));
    return root;
  }

  const contract = {
    id: 'store-row', revision: 2, sourcePath: 'src/Store.ts',
    outcomeType: 'CapacityEnforcementResult',
    durableOutcomeBinding: 'durable=true',
    aggregateOutcomeBinding: 'aggregate+=1',
    requiredSymbols: ['CapacityEnforcementResult<Row>', "outcome.kind === 'invariant-failure'"],
  };

  it('accepts an exact registry/marker/type/failure binding', () => {
    const root = fixture(`
      // capacity-enforcement-contract: store-row@2
      type Result = CapacityEnforcementResult<Row>;
      if (outcome.kind === 'invariant-failure') report();
      durable=true; aggregate+=1;
      // @unexpected-capacity-degradation contract=store-row@2
    `, contract);
    expect(validateCapacityEnforcementContracts(root, { baseRegistry: null })).toEqual([]);
  });

  it('rejects a stale nearby exception annotation', () => {
    const root = fixture(`
      // capacity-enforcement-contract: store-row@2
      type Result = CapacityEnforcementResult<Row>;
      if (outcome.kind === 'invariant-failure') report();
      durable=true; aggregate+=1;
      // @unexpected-capacity-degradation contract=store-row@1
    `, contract);
    expect(validateCapacityEnforcementContracts(root, { baseRegistry: null })).toContainEqual(expect.objectContaining({ code: 'required-binding-missing' }));
  });

  it('cannot be bypassed by synonymous prose without the typed outcome', () => {
    const root = fixture(`
      // capacity-enforcement-contract: store-row@2
      // squeeze/trim/prune this payload; the old English matcher sees none of it
      // @unexpected-capacity-degradation contract=store-row@2
    `, contract);
    expect(validateCapacityEnforcementContracts(root, { baseRegistry: null })).toContainEqual(expect.objectContaining({ code: 'required-binding-missing' }));
  });

  it('rejects an unregistered capacity marker', () => {
    const root = fixture(`
      // capacity-enforcement-contract: other-row@1
      // @unexpected-capacity-degradation contract=other-row@1
    `, contract);
    expect(validateCapacityEnforcementContracts(root, { baseRegistry: null })).toContainEqual(expect.objectContaining({ code: 'unregistered-source-marker', contract: 'other-row@1' }));
  });

  it('rejects a duplicate registered marker in a second source file', () => {
    const source = `
      // capacity-enforcement-contract: store-row@2
      CapacityEnforcementResult<Row>; outcome.kind === 'invariant-failure';
      durable=true; aggregate+=1;
      // @unexpected-capacity-degradation contract=store-row@2
    `;
    const root = fixture(source, contract);
    fs.writeFileSync(path.join(root, 'src', 'Other.ts'), '// capacity-enforcement-contract: store-row@2\n');
    const findings = validateCapacityEnforcementContracts(root, { baseRegistry: null });
    expect(findings).toContainEqual(expect.objectContaining({ code: 'marker-path-mismatch', file: 'src/Other.ts' }));
    expect(findings).toContainEqual(expect.objectContaining({ code: 'duplicate-source-marker', contract: 'store-row@2' }));
  });

  it.each([
    [{ version: 2 }, 'registry-version'],
    [{ contracts: [] }, 'contracts-nonempty'],
    [{ contracts: [{ ...contract, outcomeType: 'EnglishGuess' }] }, 'contract-outcome-type'],
    [{ contracts: [{ ...contract, durableOutcomeBinding: 42 }] }, 'contract-binding'],
    [{ contracts: [{ ...contract, aggregateOutcomeBinding: '' }] }, 'contract-binding'],
    [{ contracts: [{ ...contract, requiredSymbols: 'not-an-array' }] }, 'contract-required-symbols'],
  ])('rejects malformed registry shape %#', (override, code) => {
    const root = fixture('// capacity-enforcement-contract: store-row@2', contract, override as Record<string, unknown>);
    expect(validateCapacityEnforcementContracts(root, { baseRegistry: null })).toContainEqual(expect.objectContaining({ code }));
  });

  it('refuses contract removal unless a reviewed retirement tombstone survives', () => {
    const source = `
      // capacity-enforcement-contract: store-row@2
      CapacityEnforcementResult<Row>; outcome.kind === 'invariant-failure';
      durable=true; aggregate+=1;
      // @unexpected-capacity-degradation contract=store-row@2
    `;
    const root = fixture(source, contract);
    const baseRegistry = { version: 1, contracts: [{ ...contract }, { ...contract, id: 'old-row', revision: 4 }], retiredContracts: [] };
    expect(validateCapacityEnforcementContracts(root, { baseRegistry })).toContainEqual(expect.objectContaining({ code: 'contract-removal-without-reviewed-retirement', contract: 'old-row' }));

    fs.writeFileSync(path.join(root, 'docs', 'capacity-enforcement-contracts.json'), JSON.stringify({
      version: 1, contracts: [contract],
      retiredContracts: [{ id: 'old-row', revision: 4, retiredAt: '2026-07-19T00:00:00Z', reason: 'store removed', reviewRef: 'PR-123' }],
    }));
    expect(validateCapacityEnforcementContracts(root, { baseRegistry })).toEqual([]);
  });

  it('the real contract registry and source tree agree', () => {
    expect(validateCapacityEnforcementContracts(process.cwd())).toEqual([]);
  });
});
