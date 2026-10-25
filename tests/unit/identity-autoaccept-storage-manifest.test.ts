import { describe, expect, it } from 'vitest';
import { FileClassifier } from '../../src/core/FileClassifier.js';
import { IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS } from '../../src/core/IdentityStore.js';
import { isNeverEditable, isNeverServed } from '../../src/server/fileRoutes.js';

describe('identity auto-accept protected-storage manifest', () => {
  it('makes every authority/evidence path never-served, never-editable, and never-sync', () => {
    const classifier = new FileClassifier({ projectDir: '/repo' });
    for (const path of IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS) {
      const representative = path.endsWith('/') ? `${path}probe.json` : path;
      expect(isNeverServed(representative), `${representative} served`).toBe(true);
      expect(isNeverEditable(representative), `${representative} editable`).toBe(true);
      expect(classifier.classify(representative).strategy, `${representative} sync strategy`).toBe('never-sync');
    }
  });

  it('keeps registry convergence alive while fencing exact peer identity files', () => {
    const classifier = new FileClassifier({ projectDir: '/repo' });
    expect(classifier.classify('.instar/machines/m_peer/identity.json').strategy).toBe('never-sync');
    expect(isNeverServed('.instar/machines/m_peer/identity.json')).toBe(true);
    expect(isNeverEditable('.instar/machines/m_peer/identity.json')).toBe(true);
    expect(classifier.classify('.instar/machines/registry.json').strategy).not.toBe('never-sync');
    expect(isNeverServed('.instar/machines/registry.json')).toBe(true);
  });
});
