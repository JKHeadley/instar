// Unit tests for the shared ELI16 overview check used by /instar-dev's
// pre-commit gate and /spec-converge's convergence-tag writer. Both gates
// share scripts/eli16-overview-check.mjs to enforce one rule: every approved
// spec must ship with a plain-English companion of at least MIN_ELI16_CHARS.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor';
// @ts-expect-error: .mjs script, not typed
import { checkEli16Overview, resolveEli16Path, MIN_ELI16_CHARS } from '../../scripts/eli16-overview-check.mjs';

let tmpDir: string;
let specPath: string;

function writeSpec(frontmatter: string) {
  const content = `---\n${frontmatter}\n---\n\n# Test Spec\n\nBody.\n`;
  fs.writeFileSync(specPath, content, 'utf8');
  return frontmatter;
}

function writeEli16(filePath: string, charCount: number) {
  const prefix = '# Overview\n\n';
  const body = 'x'.repeat(Math.max(0, charCount - prefix.length));
  fs.writeFileSync(filePath, prefix + body, 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli16-check-'));
  specPath = path.join(tmpDir, 'foo.md');
});

afterEach(() => {
  try {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'eli16-overview-check.test cleanup',
    });
  } catch {
    /* best-effort */
  }
});

describe('resolveEli16Path', () => {
  it('returns sibling path when sibling exists and frontmatter is silent', () => {
    const fm = writeSpec('title: Foo');
    const siblingPath = path.join(tmpDir, 'foo.eli16.md');
    writeEli16(siblingPath, 1000);
    const r = resolveEli16Path(specPath, fm);
    expect(r.resolvedPath).toBe(siblingPath);
    expect(r.source).toBe('sibling');
  });

  it('prefers frontmatter declaration over sibling', () => {
    const fm = writeSpec('title: Foo\neli16-overview: alt-overview.md');
    const siblingPath = path.join(tmpDir, 'foo.eli16.md');
    const declaredPath = path.join(tmpDir, 'alt-overview.md');
    writeEli16(siblingPath, 1000);
    writeEli16(declaredPath, 1000);
    const r = resolveEli16Path(specPath, fm);
    expect(r.resolvedPath).toBe(declaredPath);
    expect(r.source).toBe('frontmatter');
  });

  it('returns null path when neither sibling nor frontmatter is present', () => {
    const fm = writeSpec('title: Foo');
    const r = resolveEli16Path(specPath, fm);
    expect(r.resolvedPath).toBeNull();
    expect(r.source).toBeNull();
  });

  it('strips surrounding quotes from frontmatter declaration', () => {
    const fm = writeSpec('title: Foo\neli16-overview: "alt.md"');
    const r = resolveEli16Path(specPath, fm);
    expect(r.resolvedPath).toBe(path.join(tmpDir, 'alt.md'));
  });
});

describe('checkEli16Overview', () => {
  it('passes when sibling exists and is long enough', () => {
    const fm = writeSpec('title: Foo');
    writeEli16(path.join(tmpDir, 'foo.eli16.md'), MIN_ELI16_CHARS + 100);
    const r = checkEli16Overview(specPath, fm);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.charCount).toBeGreaterThanOrEqual(MIN_ELI16_CHARS);
      expect(r.source).toBe('sibling');
    }
  });

  it('passes when frontmatter-declared file exists and is long enough', () => {
    const fm = writeSpec('title: Foo\neli16-overview: docs/overview.md');
    fs.mkdirSync(path.join(tmpDir, 'docs'));
    writeEli16(path.join(tmpDir, 'docs', 'overview.md'), MIN_ELI16_CHARS + 100);
    const r = checkEli16Overview(specPath, fm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toBe('frontmatter');
  });

  it('blocks when no overview exists at all', () => {
    const fm = writeSpec('title: Foo');
    const r = checkEli16Overview(specPath, fm);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missing');
      expect(r.siblingPath).toBe(path.join(tmpDir, 'foo.eli16.md'));
    }
  });

  it('blocks when frontmatter declares a non-existent path', () => {
    const fm = writeSpec('title: Foo\neli16-overview: missing.md');
    const r = checkEli16Overview(specPath, fm);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('declared-not-found');
  });

  it('blocks when sibling exists but is too short', () => {
    const fm = writeSpec('title: Foo');
    writeEli16(path.join(tmpDir, 'foo.eli16.md'), 100);
    const r = checkEli16Overview(specPath, fm);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('too-short');
      expect(r.charCount).toBeLessThan(MIN_ELI16_CHARS);
      expect(r.minChars).toBe(MIN_ELI16_CHARS);
    }
  });

  it('treats a stub of exactly the minimum length as passing', () => {
    const fm = writeSpec('title: Foo');
    writeEli16(path.join(tmpDir, 'foo.eli16.md'), MIN_ELI16_CHARS);
    const r = checkEli16Overview(specPath, fm);
    expect(r.ok).toBe(true);
  });

  it('treats one character below minimum as too-short', () => {
    const fm = writeSpec('title: Foo');
    writeEli16(path.join(tmpDir, 'foo.eli16.md'), MIN_ELI16_CHARS - 1);
    const r = checkEli16Overview(specPath, fm);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-short');
  });
});
