/**
 * Delight the User review gate — the pure decision logic
 * (docs/STANDARDS-REGISTRY.md → "Delight the User", a tree node under
 * "Operator-Surface Quality"; spec docs/specs/delight-the-user-standard.md).
 *
 * Both sides of every check are pinned here (Testing Integrity → semantic
 * correctness), plus wiring-integrity checks that the precommit actually calls
 * the gate on both pass paths and that screen files are in its scope.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isUserFacingSurfaceFile,
  artifactAnswersDelight,
  extractDelightSection,
  secondPassReviewedScreenshots,
  defaultFileIdentity,
} from '../../scripts/lib/delight-the-user.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PRECOMMIT = fs.readFileSync(path.join(ROOT, 'scripts/instar-dev-precommit.js'), 'utf-8');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'skills/instar-dev/templates/side-effects-artifact.md'), 'utf-8');
const REGISTRY = fs.readFileSync(path.join(ROOT, 'docs/STANDARDS-REGISTRY.md'), 'utf-8');

const ANSWER =
  'Before, the card was one long grey paragraph with a wait id and a UTC stamp in it. Now the ask leads in large ' +
  'type, the recommendation sits in a highlighted box with Approve directly under it, the checklist is real rows ' +
  'with a status each, and the time reads "since yesterday, 2:15 PM". Mac and iPhone share the same layout.';

function artifact(body: string): string {
  return `# Side-effects review\n\n## 6b. Operator-surface quality\n\nfine.\n\n## 6c. Delight the user\n\n${body}\n\n## 7. Multi-machine posture\n\nmachine-local.\n`;
}
const exists = () => true;
const missing = () => false;

describe('isUserFacingSurfaceFile — what counts as a screen', () => {
  it('YES: dashboard renderers, markup and styles (css counts: it changes what a person sees)', () => {
    expect(isUserFacingSurfaceFile('dashboard/index.html')).toBe(true);
    expect(isUserFacingSurfaceFile('dashboard/console/work-board.js')).toBe(true);
    expect(isUserFacingSurfaceFile('dashboard/desktop.css')).toBe(true);
  });
  it('YES: images and fonts a screen shows (a replaced icon changes what a person sees)', () => {
    expect(isUserFacingSurfaceFile('dashboard/logo.png')).toBe(true);
    expect(isUserFacingSurfaceFile('dashboard/fonts/inter.woff2')).toBe(true);
    expect(isUserFacingSurfaceFile('site/public/og-image.png')).toBe(true);
  });
  it('YES: pairing pages, the website pages/styles, the feedback page, approval and secret-drop pages', () => {
    expect(isUserFacingSurfaceFile('dashboard-pair/pair.html')).toBe(true);
    expect(isUserFacingSurfaceFile('site/src/pages/index.astro')).toBe(true);
    expect(isUserFacingSurfaceFile('site/src/styles/global.css')).toBe(true);
    expect(isUserFacingSurfaceFile('feedback-front/public/index.html')).toBe(true);
    expect(isUserFacingSurfaceFile('src/server/approval-page.ts')).toBe(true);
    expect(isUserFacingSurfaceFile('public/secret-drop.html')).toBe(true);
  });
  it('NO: server code, docs, website markdown, tests, images and empty input', () => {
    expect(isUserFacingSurfaceFile('src/core/SessionManager.ts')).toBe(false);
    expect(isUserFacingSurfaceFile('docs/STANDARDS-REGISTRY.md')).toBe(false);
    expect(isUserFacingSurfaceFile('site/src/content/docs/features/jobs.md')).toBe(false);
    expect(isUserFacingSurfaceFile('dashboard/docs/readme.md')).toBe(false);
    expect(isUserFacingSurfaceFile('dashboard/mandates.test.js')).toBe(false);
    expect(isUserFacingSurfaceFile('tests/unit/dashboard-glance.test.ts')).toBe(false);
    expect(isUserFacingSurfaceFile('')).toBe(false);
    expect(isUserFacingSurfaceFile(undefined as unknown as string)).toBe(false);
  });
});

describe('artifactAnswersDelight — both sides of every check', () => {
  it('PASS: a written answer plus distinct before/after screenshots that exist', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/card-before.png\n- After: /tmp/card-after.png`), { fileExists: exists });
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.screenshots.pairs).toEqual([{ before: '/tmp/card-before.png', after: '/tmp/card-after.png' }]);
  });

  it('PASS: bold field labels, backticked paths and http links are read', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n**Before:** \`shots/a.jpg\`\n**After:** https://example.com/after.png`), { fileExists: exists });
    expect(r.ok).toBe(true);
  });

  it('PASS: a new screen says so in place of the before picture', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: none — new screen: the People tab gains a Link a computer page\n- After: /tmp/after.png`), { fileExists: exists });
    expect(r.ok).toBe(true);
  });

  it('PASS: a change that moves nothing a person sees attests it with a reason', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Screenshots: no visible change — renames an internal helper in the needs model; the rendered list is identical`), {});
    expect(r.ok).toBe(true);
    expect(r.screenshots.noVisibleChange).toBe(true);
  });

  it('BLOCK: "no visible change" together with Before/After pictures is a contradiction', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/a.png\n- After: /tmp/b.png\n- Screenshots: no visible change — nothing moves on screen`), { fileExists: exists });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/both says "no visible change"/);
  });

  it('BLOCK: no delight section at all', () => {
    const r = artifactAnswersDelight('# Side-effects\n\n## 6b. Operator-surface quality\n\nok\n', { fileExists: exists });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/no "Delight the user" section/);
  });

  it('BLOCK: a placeholder answer ("yes", "n/a", "LGTM") is not an answer', () => {
    for (const word of ['yes', 'n/a', 'Delights.', 'LGTM', '']) {
      const r = artifactAnswersDelight(artifact(`${word}\n\n- Before: /tmp/a.png\n- After: /tmp/b.png`), { fileExists: exists });
      expect(r.ok).toBe(false);
      expect(r.reasons.join(' ')).toMatch(/no written answer/);
    }
  });

  it('PASS: a short, complete answer for a one-token CSS fix (no length floor)', () => {
    const r = artifactAnswersDelight(artifact('Approve now uses the shared accent and reads first on all platforms. Spacing, type, and labels are unchanged.\n\n- Before: /tmp/a.png\n- After: /tmp/b.png'), { fileExists: exists });
    expect(r.ok).toBe(true);
  });

  it('PASS: a removed screen has a before picture and "none — screen removed" after', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/old-panel.png\n- After: none — screen removed: the settings panel moved into People`), { fileExists: exists });
    expect(r.ok).toBe(true);
  });

  it('BLOCK: "none" on both sides of a pair shows nothing', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: none — new screen: a page\n- After: none — screen removed: the page`), { fileExists: exists });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/at least one real screenshot/);
  });

  it('BLOCK: an answer with no screenshot lines', () => {
    const r = artifactAnswersDelight(artifact(ANSWER), { fileExists: exists });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining(['no "Before:" screenshot line', 'no "After:" screenshot line']));
  });

  it('BLOCK: a screenshot line that names no image', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: looked bad\n- After: /tmp/b.png`), { fileExists: exists });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/"Before:" must name a screenshot image/);
  });

  it('BLOCK: a named screenshot that does not exist at commit time', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/a.png\n- After: /tmp/b.png`), { fileExists: missing });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/does not exist/);
  });

  it('BLOCK: before and after are the same picture', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/a.png\n- After: /tmp/a.png`), { fileExists: exists });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/same picture/);
  });

  it('BLOCK: a path alias of one file is still the same picture (card.png vs ./card.png)', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: shots/card.png\n- After: ./shots/card.png`), { root: '/repo', fileExists: exists });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/same picture/);
  });

  it('BLOCK: two names for identical bytes are the same picture', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/a.png\n- After: /tmp/copy-of-a.png`), {
      fileExists: exists, fileIdentity: () => 'same-sha',
    });
    expect(r.ok).toBe(false);
  });

  it('BLOCK: two existing pictures that cannot be read are not accepted as different', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/a.png\n- After: /tmp/b.png`), {
      fileExists: exists, fileIdentity: (p: string) => (p.endsWith('b.png') ? null : 'sha-a'),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/"After:" screenshot could not be read: \/tmp\/b\.png/);
  });

  it('BLOCK: an unreadable sole picture of a new screen', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: none — new screen: a new Link a computer page\n- After: /tmp/b.png`), {
      fileExists: exists, fileIdentity: () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/could not be read/);
  });

  it('PASS: one pair per screen when a change touches two screens', () => {
    const r = artifactAnswersDelight(artifact(
      `${ANSWER}\n\n- Before: /tmp/dash-before.png\n- After: /tmp/dash-after.png\n- Before: /tmp/pair-before.png\n- After: /tmp/pair-after.png`,
    ), { fileExists: exists, fileIdentity: (p: string) => p });
    expect(r.ok).toBe(true);
    expect(r.screenshots.pairs).toHaveLength(2);
  });

  it('BLOCK: unmatched Before/After counts', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/a.png\n- After: /tmp/b.png\n- After: /tmp/c.png`), { fileExists: exists });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/1 "Before:" line\(s\) but 2 "After:"/);
  });

  it('BLOCK: "no visible change" and "new screen" need a reason, and a placeholder is not one', () => {
    expect(artifactAnswersDelight(artifact(`- Screenshots: no visible change`), {}).ok).toBe(false);
    expect(artifactAnswersDelight(artifact(`- Screenshots: no visible change — n/a`), {}).ok).toBe(false);
    expect(artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: none — new screen\n- After: /tmp/b.png`), { fileExists: exists }).ok).toBe(false);
  });

  it('PASS: a short, specific "no visible change" reason is enough, with no long answer required', () => {
    const r = artifactAnswersDelight(artifact(`- Screenshots: no visible change — Renamed CSS class`), {});
    expect(r.ok).toBe(true);
  });

  it('BLOCK: "new screen" is not accepted for the after picture', () => {
    const r = artifactAnswersDelight(artifact(`${ANSWER}\n\n- Before: /tmp/a.png\n- After: none — new screen: whatever the reason is here`), { fileExists: exists });
    expect(r.ok).toBe(false);
  });

  it('BLOCK (negative control): the untouched template section does not answer itself', () => {
    const r = artifactAnswersDelight(TEMPLATE, { fileExists: exists, templateText: TEMPLATE });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/no written answer/);
    expect(r.reasons).toEqual(expect.arrayContaining(['no "Before:" screenshot line', 'no "After:" screenshot line']));
  });

  it('BLOCK: template guidance kept verbatim does not count toward the answer', () => {
    const section = extractDelightSection(TEMPLATE) ?? '';
    const filled = section.replace(/- Before: \[.*\]/, '- Before: /tmp/a.png').replace(/- After: \[.*\]/, '- After: /tmp/b.png');
    const r = artifactAnswersDelight(artifact(filled), { fileExists: exists, templateText: TEMPLATE });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/no written answer/);
  });

  it('the section ends at the next heading of the same level', () => {
    const s = extractDelightSection(artifact('body text'));
    expect(s).toContain('body text');
    expect(s).not.toContain('machine-local');
  });

  it('handles empty / undefined input safely', () => {
    expect(artifactAnswersDelight('').ok).toBe(false);
    expect(artifactAnswersDelight(undefined as unknown as string).ok).toBe(false);
  });
});

describe('secondPassReviewedScreenshots — a second reader, bound to the pictures', () => {
  const pairs = [{ before: '/tmp/shots/card-before.png', after: '/tmp/shots/card-after.png' }];
  const doc = (review: string) => `# SE\n\n## Second-pass review\n\n**Reviewer:** independent reviewer subagent\n\n${review}\n`;
  it('PASS: concurring trace + a section naming every picture', () => {
    const r = secondPassReviewedScreenshots(doc('Concur. Compared card-before.png with card-after.png at 390 wide.'), { secondPass: 'true', reviewerConcurred: true }, pairs);
    expect(r).toEqual({ ok: true, reasons: [] });
  });
  it('BLOCK: no second pass or no concurrence in the trace', () => {
    expect(secondPassReviewedScreenshots(doc('card-before.png card-after.png fine'), { secondPass: 'not-required', reviewerConcurred: null }, pairs).ok).toBe(false);
    expect(secondPassReviewedScreenshots(doc('card-before.png card-after.png fine'), { secondPass: true, reviewerConcurred: false }, pairs).ok).toBe(false);
  });
  it('BLOCK: a section that does not name the pictures, or no section', () => {
    const r = secondPassReviewedScreenshots(doc('Concur, looks good.'), { secondPass: true, reviewerConcurred: true }, pairs);
    expect(r.reasons.join(' ')).toMatch(/card-before\.png/);
    expect(secondPassReviewedScreenshots('# SE\n', { secondPass: true, reviewerConcurred: true }, pairs).ok).toBe(false);
  });
  it('BLOCK: the same rules as the merge-time review check — a string "true" concurrence and a missing or pending Reviewer line fail', () => {
    const named = doc('Concur. card-before.png card-after.png');
    expect(secondPassReviewedScreenshots(named, { secondPass: true, reviewerConcurred: 'true' }, pairs).ok).toBe(false);
    const noReviewer = '# SE\n\n## Second-pass review\n\nConcur. card-before.png card-after.png\n';
    expect(secondPassReviewedScreenshots(noReviewer, { secondPass: true, reviewerConcurred: true }, pairs).ok).toBe(false);
    const pending = '# SE\n\n## Second-pass review\n\n**Reviewer:** pending\n\ncard-before.png card-after.png\n';
    expect(secondPassReviewedScreenshots(pending, { secondPass: true, reviewerConcurred: true }, pairs).ok).toBe(false);
  });
  it('BLOCK: one ambiguous mention when two pictures share a file name; PASS with both paths', () => {
    const twin = [{ before: 'shots/before/card.png', after: 'shots/after/card.png' }];
    const trace = { secondPass: true, reviewerConcurred: true };
    expect(secondPassReviewedScreenshots(doc('Concur: card.png reads well now.'), trace, twin).ok).toBe(false);
    expect(secondPassReviewedScreenshots(doc('Concur: compared shots/before/card.png and shots/after/card.png.'), trace, twin).ok).toBe(true);
  });
  it('BLOCK: a name inside another name is not a reference (card.png inside new-card.png)', () => {
    const p2 = [{ before: '/tmp/card.png', after: '/tmp/new-card.png' }];
    const trace = { secondPass: true, reviewerConcurred: true };
    const r = secondPassReviewedScreenshots(doc('Concur: new-card.png reads well.'), trace, p2);
    expect(r.reasons.join(' ')).toMatch(/reviewed: card\.png/);
    expect(secondPassReviewedScreenshots(doc('Concur: card.png, then new-card.png.'), trace, p2).ok).toBe(true);
    expect(secondPassReviewedScreenshots(doc('Concur: `card.png` vs `new-card.png`.'), trace, p2).ok).toBe(true);
  });
  it('PASS: the exact paths copied from the artifact count as references', () => {
    const p3 = [{ before: 'shots/before.png', after: 'shots/after.png' }];
    const trace = { secondPass: true, reviewerConcurred: true };
    expect(secondPassReviewedScreenshots(doc('Concur: compared shots/before.png with shots/after.png.'), trace, p3).ok).toBe(true);
    expect(secondPassReviewedScreenshots(doc('Concur: compared before.png with after.png.'), trace, p3).ok).toBe(true);
  });
  it('"none" sides need no naming; links are named in full', () => {
    const r = secondPassReviewedScreenshots(doc('Concur: https://x.test/a.png reviewed.'), { secondPass: true, reviewerConcurred: true }, [{ before: 'none', after: 'https://x.test/a.png' }]);
    expect(r.ok).toBe(true);
  });
});

describe('defaultFileIdentity — never opens what is not a regular file', () => {
  it('returns null for a device, a directory and a missing path', () => {
    expect(defaultFileIdentity('/dev/zero')).toBeNull();
    expect(defaultFileIdentity(ROOT)).toBeNull();
    expect(defaultFileIdentity(path.join(ROOT, 'no-such-file.png'))).toBeNull();
  });
  it('returns size:sha256 for a regular file, equal for equal bytes', () => {
    const a = defaultFileIdentity(path.join(ROOT, 'package.json'));
    expect(a).toMatch(/^\d+:[a-f0-9]{64}$/);
    expect(defaultFileIdentity(path.join(ROOT, 'package.json'))).toBe(a);
  });
});

describe('wiring integrity — the gate is real, not a no-op', () => {
  it('the precommit defines assertDelightTheUser on the shared lib predicates and blocks on it', () => {
    expect(PRECOMMIT).toMatch(/function assertDelightTheUser\(/);
    expect(PRECOMMIT).toMatch(/from '\.\/lib\/delight-the-user\.mjs'/);
    expect(PRECOMMIT).toMatch(/artifactAnswersDelight\(content, \{ root: ROOT, fileExists: defaultFileExists, fileIdentity: defaultFileIdentity, templateText \}\)/);
    const fn = PRECOMMIT.slice(PRECOMMIT.indexOf('function assertDelightTheUser('));
    expect(fn.slice(0, 2500)).toMatch(/blockCommit\(/);
  });
  it('the gate runs on BOTH pass paths (Tier-1 lite AND Tier-2 full), deletions included', () => {
    expect(PRECOMMIT).toContain('\nassertDelightTheUser([...staged, ...scopeOnlyPaths], validTrace.trace);');
    expect(PRECOMMIT).toContain('\n  assertDelightTheUser([...staged, ...scopeOnlyPaths], trace);');
    expect(PRECOMMIT).toMatch(/secondPassReviewedScreenshots\(content, trace, verdict\.screenshots\.pairs\)/);
  });
  it('screen files are in the gate scope, so a dashboard-only commit is reviewed', () => {
    // The rule lives in scripts/lib/instar-dev-scope.mjs (docs/specs/judgment-call-rating.md).
    expect(PRECOMMIT).toContain('const inScope = isInstarDevInScope;');
    const SCOPE = fs.readFileSync(path.join(ROOT, 'scripts/lib/instar-dev-scope.mjs'), 'utf-8');
    const inScope = SCOPE.slice(SCOPE.indexOf('export function isInstarDevInScope(file)'));
    expect(inScope).toMatch(/isUserFacingSurfaceFile\(file\)/);
  });
  it('the template seeds the §6c question and both screenshot lines', () => {
    expect(TEMPLATE).toMatch(/## 6c\. Delight the user/);
    expect(TEMPLATE).toMatch(/^- Before: /m);
    expect(TEMPLATE).toMatch(/^- After: /m);
    expect(TEMPLATE).toMatch(/^- Screenshots: no visible change/m);
  });
  it('the registry article cites this gate and its tests', () => {
    const art = REGISTRY.slice(REGISTRY.indexOf('### Delight the User'), REGISTRY.indexOf('### Agent Proposes, Operator Approves'));
    expect(art).toMatch(/a tree node under \*Operator-Surface Quality\*/);
    expect(art).toContain('scripts/lib/delight-the-user.mjs');
    expect(art).toContain('tests/unit/delight-the-user-gate.test.ts');
    expect(art).toContain('[source: telegram 134088/145506 2026-11-19T04:12:03Z]');
  });
});
