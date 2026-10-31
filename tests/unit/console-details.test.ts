import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { details } from '../../dashboard/console/ui.js';

describe('console detail sheets', () => {
  it('shows plain context without leaking internal keys, IDs or JSON blobs', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, { document: dom.window.document });
    const fold = details({
      status: 'needs-reauth', createdAt: '2026-10-30T18:00:00.000Z', toolsUsed: 'Bash',
      machineId: 'm_03b30f5b32c6ef3eb0afd3ca7054e252', token: 'secret',
      nested: { internal: 'value' },
    }, ['status', 'createdAt', 'toolsUsed', 'machineId', 'token', 'nested']);
    const words = fold.textContent || '';
    expect(words).toContain('More context');
    expect(words).toContain('needs reauth');
    expect(words).toContain('Bash');
    expect(words).toContain('Oct 30, 2026');
    expect(words).not.toMatch(/machineId|m_03b|token|secret|nested|\{"internal"/);
    dom.window.close();
  });

  it('hides an empty fold instead of showing a useless technical section', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, { document: dom.window.document });
    const fold = details({ id: 'CMT-1081', originMachineId: 'm_03b30f5b32c6ef3eb0afd3ca7054e252' }, ['id', 'originMachineId']);
    expect(fold.hidden).toBe(true);
    dom.window.close();
  });
});
