import { describe, expect, it } from 'vitest';
import {
  auditMigrationConsumerCompleteness,
  validateMigrationManifest,
} from '../../scripts/lint-migration-consumer-completeness.js';

const contract = {
  id: 'threadline-inbound-canonical-store',
  revision: 1,
  producers: ['src/threadline/ThreadLog.ts'],
  consumers: ['src/threadline/ThreadlineReplyValidation.ts'],
  validators: [
    'tests/unit/threadline/ThreadlineReplyValidation.test.ts',
    'tests/integration/threadline-relay-send-priority.test.ts',
  ],
};

const existing = new Set([
  ...contract.producers,
  ...contract.consumers,
  ...contract.validators,
]);

describe('migration-consumer completeness lint', () => {
  it('rejects missing, malformed, and empty contract registries', () => {
    expect(validateMigrationManifest(null)).toContainEqual(expect.objectContaining({ rule: 'MCC0-manifest-shape' }));
    expect(validateMigrationManifest({ schemaVersion: 2, contracts: [{}] })).toContainEqual(expect.objectContaining({ rule: 'MCC0-manifest-shape' }));
    expect(validateMigrationManifest({ schemaVersion: 1, contracts: [] })).toContainEqual(expect.objectContaining({ rule: 'MCC0-manifest-shape' }));
    expect(validateMigrationManifest({ schemaVersion: 1, contracts: [contract] })).toEqual([]);
  });

  it('rejects a canonical producer with no registered consumer or validator', () => {
    const findings = auditMigrationConsumerCompleteness({
      contracts: [{ ...contract, consumers: [], validators: [] }],
      markers: [{ role: 'producer', id: contract.id, revision: 1, path: contract.producers[0] }],
      changedFiles: new Set(),
      pathExists: (path) => existing.has(path),
    });

    expect(findings.map((finding) => finding.rule)).toEqual(expect.arrayContaining([
      'MCC2-consumer-required',
      'MCC3-validator-required',
    ]));
  });

  it('rejects a producer change without a contract revision bump', () => {
    const findings = auditMigrationConsumerCompleteness({
      contracts: [contract],
      baseContracts: [contract],
      markers: [
        { role: 'producer', id: contract.id, revision: 1, path: contract.producers[0] },
        { role: 'consumer', id: contract.id, revision: 1, path: contract.consumers[0] },
        ...contract.validators.map((path) => ({ role: 'validator' as const, id: contract.id, revision: 1, path })),
      ],
      changedFiles: new Set(contract.producers),
      pathExists: (path) => existing.has(path),
    });

    expect(findings).toContainEqual(expect.objectContaining({ rule: 'MCC6-revision-bump-required' }));
  });

  it('passes when a revision bump is acknowledged by every producer, consumer, and validator', () => {
    const revised = { ...contract, revision: 2 };
    const markers = [
      { role: 'producer' as const, id: contract.id, revision: 2, path: contract.producers[0] },
      { role: 'consumer' as const, id: contract.id, revision: 2, path: contract.consumers[0] },
      ...contract.validators.map((path) => ({ role: 'validator' as const, id: contract.id, revision: 2, path })),
    ];
    const findings = auditMigrationConsumerCompleteness({
      contracts: [revised],
      baseContracts: [contract],
      markers,
      changedFiles: new Set(existing),
      pathExists: (path) => existing.has(path),
    });

    expect(findings).toEqual([]);
  });

  it('rejects a marker that is absent from the contract registry', () => {
    const findings = auditMigrationConsumerCompleteness({
      contracts: [contract],
      markers: [{ role: 'producer', id: 'unregistered-migration', revision: 1, path: 'src/new-authority.ts' }],
      changedFiles: new Set(),
      pathExists: () => true,
    });

    expect(findings).toContainEqual(expect.objectContaining({ rule: 'MCC1-unregistered-marker' }));
  });

  it('rejects declared paths without the matching role marker', () => {
    const findings = auditMigrationConsumerCompleteness({
      contracts: [contract],
      markers: [{ role: 'producer', id: contract.id, revision: 1, path: contract.producers[0] }],
      changedFiles: new Set(),
      pathExists: (path) => existing.has(path),
    });

    expect(findings).toContainEqual(expect.objectContaining({
      rule: 'MCC5-missing-role-marker',
      path: contract.consumers[0],
    }));
  });

  it('rejects silent removal of a previously registered contract', () => {
    const findings = auditMigrationConsumerCompleteness({
      contracts: [],
      baseContracts: [contract],
      markers: [],
      changedFiles: new Set(),
      pathExists: () => true,
    });
    expect(findings).toContainEqual(expect.objectContaining({ rule: 'MCC8-contract-removal-forbidden' }));
  });

  it('rejects silent removal of a producer, consumer, or validator path', () => {
    for (const field of ['producers', 'consumers', 'validators'] as const) {
      const reduced = { ...contract, [field]: contract[field].slice(1) };
      const findings = auditMigrationConsumerCompleteness({
        contracts: [reduced], baseContracts: [contract], markers: [],
        changedFiles: new Set(), pathExists: (path) => existing.has(path),
      });
      expect(findings).toContainEqual(expect.objectContaining({
        rule: 'MCC8-role-removal-forbidden', path: contract[field][0],
      }));
    }
  });

  it('rejects a revision bump when a validator did not acknowledge it', () => {
    const revised = { ...contract, revision: 2 };
    const findings = auditMigrationConsumerCompleteness({
      contracts: [revised],
      baseContracts: [contract],
      markers: [
        { role: 'producer', id: contract.id, revision: 2, path: contract.producers[0] },
        { role: 'consumer', id: contract.id, revision: 2, path: contract.consumers[0] },
        ...contract.validators.map((path) => ({ role: 'validator' as const, id: contract.id, revision: 2, path })),
      ],
      changedFiles: new Set([...contract.producers, ...contract.consumers, contract.validators[0]]),
      pathExists: (path) => existing.has(path),
    });
    expect(findings).toContainEqual(expect.objectContaining({
      rule: 'MCC7-lockstep-validator',
      path: contract.validators[1],
    }));
  });
});
