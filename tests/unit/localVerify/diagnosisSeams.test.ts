import { describe, expect, it } from 'vitest';
import { parseDiagnosisGroupMembers } from '../../../src/localVerify/diagnosisSeams.js';

describe('diagnosis process-group scan', () => {
  it('excludes its own ps probe while retaining real descendants', () => {
    const rows = '100 1 100 node\n101 100 100 ps\n102 100 100 npm\n103 102 100 node\n104 1 104 node\n';
    expect(parseDiagnosisGroupMembers(rows, 100)).toEqual([102, 103]);
    expect(parseDiagnosisGroupMembers('100 1 100 node\n101 100 100 ps\n', 100)).toEqual([]);
  });

  it('refuses a non-leader or missing leader rather than claiming cleanup', () => {
    expect(parseDiagnosisGroupMembers('100 1 99 node\n101 100 99 ps\n', 100)).toBeNull();
    expect(parseDiagnosisGroupMembers('', 100)).toBeNull();
  });
});
