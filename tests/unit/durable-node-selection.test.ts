/**
 * Unit tests for ABI-aware durable node selection (selectDurableNode).
 *
 * The recurring "SQLite breaks after brew upgrade" bane: the node-symlink
 * selection preferred /opt/homebrew/bin/node (the stable, non-versioned
 * path) for durability — but homebrew bumps that symlink to the latest
 * major (e.g. Node 25), which has no matching better-sqlite3 prebuilt and
 * won't compile from source. The selection must prefer an ABI-compatible
 * node, and only fall back to durability-only when nothing is compatible.
 */

import { describe, it, expect } from 'vitest';
import { selectDurableNode } from '../../src/commands/setup.js';

const HOMEBREW_STABLE = '/opt/homebrew/bin/node';            // durable, but tracks latest major
const USR_LOCAL = '/usr/local/bin/node';                     // durable
const ASDF_22 = '/Users/x/.asdf/installs/nodejs/22.18.0/bin/node'; // version-specific
const NVM_20 = '/Users/x/.nvm/versions/node/v20.11.1/bin/node';    // version-specific
const CELLAR_25 = '/opt/homebrew/Cellar/node/25.6.1/bin/node';     // version-specific

const allUsable = () => true;

describe('selectDurableNode', () => {
  describe('durability-only (no ABI predicate) — preserves prior behavior', () => {
    it('prefers the stable homebrew path over version-specific paths', () => {
      const pick = selectDurableNode([ASDF_22, HOMEBREW_STABLE, CELLAR_25], allUsable);
      expect(pick).toBe(HOMEBREW_STABLE);
    });

    it('prefers /usr/local/bin when homebrew stable is absent', () => {
      const pick = selectDurableNode([ASDF_22, USR_LOCAL, NVM_20], allUsable);
      expect(pick).toBe(USR_LOCAL);
    });

    it('falls back to a version-specific path when no stable path exists', () => {
      const pick = selectDurableNode([ASDF_22, NVM_20], allUsable);
      // First version-specific candidate in order.
      expect(pick).toBe(ASDF_22);
    });

    it('filters out non-usable (non-existent) candidates', () => {
      const usableOnly = (p: string) => p === ASDF_22; // only asdf "exists"
      const pick = selectDurableNode([HOMEBREW_STABLE, ASDF_22, CELLAR_25], usableOnly);
      expect(pick).toBe(ASDF_22);
    });
  });

  describe('ABI-aware (with compatibility predicate) — the bane fix', () => {
    it('picks the ABI-compatible version-specific node over an incompatible stable node', () => {
      // The exact codey scenario: homebrew stable is Node 25 (incompatible),
      // asdf 22 is compatible. The fix must choose asdf 22 even though it's
      // version-specific, because the stable path can't load better-sqlite3.
      const isCompatible = (p: string) => p === ASDF_22;
      const pick = selectDurableNode([HOMEBREW_STABLE, ASDF_22, CELLAR_25], allUsable, isCompatible);
      expect(pick).toBe(ASDF_22);
    });

    it('prefers a compatible STABLE node when one exists (durability within compatible set)', () => {
      // If homebrew stable happens to be compatible, it still wins — we only
      // avoid it when it's NOT compatible.
      const isCompatible = (p: string) => p === HOMEBREW_STABLE || p === ASDF_22;
      const pick = selectDurableNode([ASDF_22, HOMEBREW_STABLE, CELLAR_25], allUsable, isCompatible);
      expect(pick).toBe(HOMEBREW_STABLE);
    });

    it('falls back to durability-only when NO candidate is compatible', () => {
      // Nothing can load the module — produce at least a working node symlink
      // (the native-module degradation surfaces separately). Durability wins.
      const isCompatible = () => false;
      const pick = selectDurableNode([ASDF_22, HOMEBREW_STABLE, CELLAR_25], allUsable, isCompatible);
      expect(pick).toBe(HOMEBREW_STABLE);
    });

    it('chooses among multiple compatible version-specific nodes by order', () => {
      const isCompatible = (p: string) => p === NVM_20 || p === ASDF_22;
      // homebrew stable is incompatible; both version-specific are compatible;
      // neither matches a stable prefix, so first-in-order (NVM_20) wins.
      const pick = selectDurableNode([NVM_20, ASDF_22, HOMEBREW_STABLE], allUsable, isCompatible);
      expect(pick).toBe(NVM_20);
    });

    it('respects usability AND compatibility together', () => {
      // asdf exists+compatible; homebrew exists but incompatible; cellar
      // compatible but does NOT exist. Pick asdf.
      const isUsable = (p: string) => p !== CELLAR_25;
      const isCompatible = (p: string) => p === ASDF_22 || p === CELLAR_25;
      const pick = selectDurableNode([HOMEBREW_STABLE, CELLAR_25, ASDF_22], isUsable, isCompatible);
      expect(pick).toBe(ASDF_22);
    });
  });

  describe('edge cases', () => {
    it('returns undefined for an empty candidate list', () => {
      expect(selectDurableNode([], allUsable)).toBeUndefined();
    });

    it('returns undefined when nothing is usable', () => {
      expect(selectDurableNode([HOMEBREW_STABLE, ASDF_22], () => false)).toBeUndefined();
    });
  });
});
