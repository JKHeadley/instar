/**
 * lint-no-unfunneled-credential-write — evasion resistance.
 *
 * This lint guards a credential path: every Claude credential write must go
 * through CredentialWriteFunnel.withSlotLock (spec §2.2). A peer-agent audit
 * classified it DEFEATABLE by ordinary renaming; three bypasses were then
 * reproduced against it, all confirmed EVADING before this change:
 *
 *   const SVC = 'Claude Code' + '-credentials';            // concatenated service
 *   execFileSync('security', ['add-generic-password', '-s', SVC]);
 *   const store = defaultCredentialStore; store.write(p);  // re-bound receiver
 *   provider['writeCredentials'](p);                       // computed access
 *
 * The first is the sharpest: the raw-keychain rule is GATED on the literal
 * service string appearing in the file, so splitting it across a concatenation
 * switches the entire rule off.
 *
 * The detector is driven DIRECTLY here rather than via the CLI's exit code —
 * a lint that CRASHES also exits 1, so exit-code-only assertions cannot tell
 * "caught it" from "died on startup".
 */

import { describe, expect, it } from 'vitest';
import {
  collapseConcatenation,
  credentialStoreBindings,
  findCredentialWriteViolations,
  // @ts-expect-error — plain .js lint script, no type declarations
} from '../../scripts/lint-no-unfunneled-credential-write.js';

const SERVICE = 'Claude Code-credentials';

describe('collapseConcatenation', () => {
  it('folds a split literal so the service gate cannot be disarmed', () => {
    expect(collapseConcatenation(`const S = 'Claude Code' + '-credentials';`)).toContain(SERVICE);
  });

  it('folds a chain of concatenations', () => {
    expect(collapseConcatenation(`const S = 'Claude' + ' Code' + '-credent' + 'ials';`)).toContain(SERVICE);
  });

  it('CONTROL: leaves unrelated text alone', () => {
    const src = `const S = 'WorktreeKeyVault';`;
    expect(collapseConcatenation(src)).toContain('WorktreeKeyVault');
    expect(collapseConcatenation(src)).not.toContain(SERVICE);
  });
});

describe('credentialStoreBindings', () => {
  it('resolves a re-binding, and a chain of them, to a fixpoint', () => {
    const src = ['const store = defaultCredentialStore;', 'const s2 = store;'].join('\n');
    const names = credentialStoreBindings(src);
    expect(names).toContain('store');
    expect(names).toContain('s2');
  });

  it('CONTROL: an unrelated re-binding is not absorbed', () => {
    expect(credentialStoreBindings('const store = somethingElse;')).not.toContain('store');
  });
});

describe('findCredentialWriteViolations — the three bypasses', () => {
  it('CONTROL: the plain forms are still caught', () => {
    expect(findCredentialWriteViolations('defaultCredentialStore.write(p);')).toHaveLength(1);
    expect(findCredentialWriteViolations('provider.writeCredentials(p);')).toHaveLength(1);
    expect(
      findCredentialWriteViolations(
        [`const svc = '${SERVICE}';`, "execFileSync('security', ['add-generic-password', '-s', svc]);"].join('\n'),
      ),
    ).toHaveLength(1);
  });

  it('BYPASS 1: a CONCATENATED service literal no longer disarms the keychain rule', () => {
    const src = [
      `const SVC = 'Claude Code' + '-credentials';`,
      "execFileSync('security', ['add-generic-password', '-s', SVC]);",
    ].join('\n');
    // Confirmed EVADING before this change.
    expect(findCredentialWriteViolations(src)).toHaveLength(1);
  });

  it('BYPASS 2: a RE-BOUND credential store is caught', () => {
    const src = ['const store = defaultCredentialStore;', 'store.write(payload);'].join('\n');
    expect(findCredentialWriteViolations(src)).toHaveLength(1);
  });

  it('BYPASS 3: COMPUTED access to writeCredentials is caught', () => {
    expect(findCredentialWriteViolations("provider['writeCredentials'](payload);")).toHaveLength(1);
  });

  it('BYPASS 2b: computed write on a re-bound store is caught', () => {
    const src = ['const store = defaultCredentialStore;', "store['write'](payload);"].join('\n');
    expect(findCredentialWriteViolations(src)).toHaveLength(1);
  });

  // ── The other direction. This gate exists to keep the OTHER keychain vaults
  //    from tripping the rule; widening it without these would swap a missed
  //    violation for a wall of false ones on unrelated, correct code.
  it('CONTROL: a DIFFERENT keychain service is NOT flagged', () => {
    const src = [
      `const svc = 'WorktreeKeyVault';`,
      "execFileSync('security', ['add-generic-password', '-s', svc]);",
    ].join('\n');
    expect(findCredentialWriteViolations(src)).toEqual([]);
  });

  it('CONTROL: a raw keychain write with no guarded-service reference is NOT flagged', () => {
    expect(
      findCredentialWriteViolations("execFileSync('security', ['add-generic-password', '-s', other]);"),
    ).toEqual([]);
  });

  it('CONTROL: an unrelated .write( is not flagged', () => {
    expect(findCredentialWriteViolations('someOtherStore.write(p);')).toEqual([]);
  });

  it('CONTROL: comments are not violations', () => {
    const src = ['// defaultCredentialStore.write(p);', ' * provider.writeCredentials(p);'].join('\n');
    expect(findCredentialWriteViolations(src)).toEqual([]);
  });
});
