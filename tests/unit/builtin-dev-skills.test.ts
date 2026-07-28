/**
 * Ratchet + wiring tests for the bundled developer-skill toolkit
 * (BUNDLED_DEV_SKILLS) installed by installBundledDevSkills.
 *
 * This is the structural guarantee that the "tracked-in-repo but never installed/
 * shipped" bug (the gap that motivated docs/specs/BUILTIN-SKILL-INSTALL-SINGLE-SOURCE.md)
 * cannot silently recur for the dev toolkit:
 *   1. every allowlisted skill has a tracked source dir under skills/
 *   2. the skills/ source dir is shipped (package.json files[])
 *   3. installBundledDevSkills actually materializes each SKILL.md on disk
 *   4. no install-set skill ships a bare localhost:<port> (must be runtime-templated)
 *   5. install is idempotent (never clobbers a user-customized skill)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBundledDevSkills, BUNDLED_DEV_SKILLS } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = process.cwd();
const SKILLS_SRC = path.join(REPO_ROOT, 'skills');

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(full));
    else if (e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

let target: string;
beforeEach(() => {
  target = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dev-skills-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(target, { recursive: true, force: true, operation: 'tests/unit/builtin-dev-skills.test.ts' });
});

describe('bundled dev-skill toolkit — single-source install', () => {
  it('every allowlisted skill has a tracked source dir under skills/', () => {
    for (const slug of BUNDLED_DEV_SKILLS) {
      expect(
        fs.existsSync(path.join(SKILLS_SRC, slug, 'SKILL.md')),
        `skills/${slug}/SKILL.md missing`,
      ).toBe(true);
    }
  });

  it('the skills/ source dir ships (is in package.json files[])', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('skills');
  });

  it('installBundledDevSkills materializes every allowlisted SKILL.md on disk (wiring-integrity)', () => {
    installBundledDevSkills(target);
    for (const slug of BUNDLED_DEV_SKILLS) {
      expect(
        fs.existsSync(path.join(target, slug, 'SKILL.md')),
        `${slug} did not install`,
      ).toBe(true);
    }
  });

  it('skills with subdirs (spec-converge, instar-dev) carry scripts/templates on install', () => {
    installBundledDevSkills(target);
    expect(fs.existsSync(path.join(target, 'spec-converge', 'scripts'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'instar-dev', 'templates'))).toBe(true);
  });

  it('no install-set skill ships a bare localhost:<port> (port must be ${INSTAR_PORT}-templated)', () => {
    for (const slug of BUNDLED_DEV_SKILLS) {
      for (const f of walkMd(path.join(SKILLS_SRC, slug))) {
        const txt = fs.readFileSync(f, 'utf-8');
        // after the port fix, every `localhost:` is followed by `${INSTAR_PORT...}`,
        // never a bare digit — so localhost:<digit> is the failure signature.
        expect(txt, `${path.relative(REPO_ROOT, f)} contains a bare localhost:<port>`).not.toMatch(/localhost:\d/);
      }
    }
  });

  it('install is idempotent — does not clobber a user-customized skill', () => {
    const custom = '---\nname: instar-dev\n---\n\n# customized by user\n';
    fs.mkdirSync(path.join(target, 'instar-dev'), { recursive: true });
    fs.writeFileSync(path.join(target, 'instar-dev', 'SKILL.md'), custom);
    installBundledDevSkills(target);
    expect(fs.readFileSync(path.join(target, 'instar-dev', 'SKILL.md'), 'utf-8')).toBe(custom);
  });
});
