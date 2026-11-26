import { describe, expect, it } from 'vitest';
import { selectWindowWorkTask } from '../../src/server/AgentServer.js';

const ledger = (tasks: string, runId = 'run-one') => `---\nrun_id: "${runId}"\n---\n\n# Work\n${tasks}`;
const openTwo = ledger('- [ ] Implement fix\n- [ ] Verify fix\n');

describe('W32 work receipt task selection', () => {
  it('prefers the first open task without a receipt', () => {
    expect(selectWindowWorkTask(openTwo, 'run-one', new Set())).toBe('autonomous:run-one:1');
    expect(selectWindowWorkTask(openTwo, 'run-one', new Set(['autonomous:run-one:1']))).toBe('autonomous:run-one:2');
  });

  it('attributes later changed work to a still-open task after every open task was receipted', () => {
    const used = new Set(['autonomous:run-one:1', 'autonomous:run-one:2']);
    expect(selectWindowWorkTask(openTwo, 'run-one', used)).toBe('autonomous:run-one:1');
    expect(selectWindowWorkTask(ledger('- [x] Implement fix\n- [ ] Verify fix\n'), 'run-one', used)).toBe('autonomous:run-one:2');
  });

  it('refuses completed ledgers and a mismatched run', () => {
    expect(selectWindowWorkTask(ledger('- [x] Implement fix\n- [x] Verify fix\n'), 'run-one', new Set())).toBeNull();
    expect(() => selectWindowWorkTask(openTwo, 'other-run', new Set())).toThrow('window-run-liveness-task-ledger-run-mismatch');
  });
});
