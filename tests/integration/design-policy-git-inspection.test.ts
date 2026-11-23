import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectDesignGitTrees } from '../../src/designGate/gitInspection.js';
import { createDesignPolicyGitRepo } from '../fixtures/designPolicyGitRepo.js';
const owned: ReturnType<typeof createDesignPolicyGitRepo>[] = [];
const fixture = () => { const f = createDesignPolicyGitRepo(); owned.push(f); return f; };
afterEach(async () => { for (const f of owned.splice(0)) await f.cleanup(); });
describe('manual inspector reads immutable real Git trees', () => {
 it('pins both refs and ignores uncommitted changes to policy and source', async () => {
  const f = fixture(); f.write('docs/DESIGN-STANDARD.md', 'invalid uncommitted content');
  const r = await inspectDesignGitTrees({ repo: f.root, base: f.base, head: 'HEAD' });
  expect(r.status).toBe('structurally-valid'); expect(r.baseCommit).toBe(f.base); expect(r.headCommit).toBe(f.base);
 });
 it('keeps base registrations when head edits both registry and source', async () => {
  const f = fixture(); const head = f.commit({ 'docs/design/screens.json': '{"version":1,"screens":[]}', 'dashboard/accounts.js': 'export const title = "Changed";' });
  const r = await inspectDesignGitTrees({ repo: f.root, base: f.base, head });
  expect(r.status).toBe('structurally-valid'); if ('classification' in r) expect(r.classification.screens).toEqual(['accounts']);
 });
 it('detects a removed HTML marker from base source instead of inspecting only candidate text', async () => {
  const f = fixture(); const head = f.commit({ 'src/page.ts': 'export const page = "disabled";' });
  const r = await inspectDesignGitTrees({ repo: f.root, base: f.base, head });
  expect(r.status).toBe('findings'); if ('classification' in r) expect(r.classification.unregistered).toContain('src/page.ts');
 });
 it('never executes candidate files and handles filenames literally', async () => {
  const f = fixture(); const name = 'dashboard/$(touch unsafe).html'; const head = f.commit({ [name]: '<html>Invented test data</html>' });
  const r = await inspectDesignGitTrees({ repo: f.root, base: f.base, head });
  expect(r.status).toBe('findings'); expect(fs.existsSync(path.join(f.root, 'unsafe'))).toBe(false);
  if ('classification' in r) expect(r.classification.unregistered).toContain(name);
 });
 it('reports unavailable for malformed JSON and option-like refs', async () => {
  const f = fixture(); const head = f.commit({ 'docs/design/screens.json': '{' });
  expect(await inspectDesignGitTrees({ repo: f.root, base: f.base, head })).toMatchObject({ status: 'unavailable', code: 'policy-json-invalid' });
  expect(await inspectDesignGitTrees({ repo: f.root, base: '--help', head })).toMatchObject({ status: 'unavailable' });
 });
 it('refuses policy symlinks rather than reading host files', async () => {
  const f = fixture(); fs.symlinkSync('/etc/passwd', path.join(f.root, 'policy-link'));
  f.git('add', '--', 'policy-link'); f.git('commit', '-qm', 'Synthetic symlink');
  // Replace the policy tree entry using actual Git objects, without following it.
  const blob = f.git('rev-parse', 'HEAD:policy-link');
  const head = f.commitObjects([{ path: Buffer.from('docs/design/screens.json'), mode: '120000', oid: blob }]);
  expect(await inspectDesignGitTrees({ repo: f.root, base: f.base, head })).toMatchObject({ status: 'unavailable', code: 'non-regular-policy-or-source' });
 });
 it('refuses absent baseline policy instead of treating bootstrap as a successful gate', async () => {
  const f = fixture(); const empty = f.git('hash-object', '-t', 'tree', '--stdin');
  const commit = f.git('commit-tree', empty, '-m', 'Synthetic empty policy');
  expect(await inspectDesignGitTrees({ repo: f.root, base: commit, head: f.base })).toMatchObject({ status: 'unavailable', code: 'policy-missing' });
 });
 it('ignores local replacement refs so reported commit IDs identify the bytes actually read', async () => {
  const f = fixture(); const replacement = f.commit({ 'docs/DESIGN-STANDARD.md': 'Invalid replacement document' });
  f.git('replace', f.base, replacement);
  const r = await inspectDesignGitTrees({ repo: f.root, base: f.base, head: f.base });
  expect(r.status).toBe('structurally-valid'); expect(r.baseCommit).toBe(f.base);
 });

 it('refuses backslash Git paths instead of aliasing a registered slash path', async () => {
  const f = fixture(); const head = f.commit({ ['dashboard' + String.fromCharCode(92) + 'accounts.js']: '<html>Different literal file</html>' });
  expect(await inspectDesignGitTrees({ repo: f.root, base: f.base, head })).toMatchObject({ status: 'unavailable', code: 'noncanonical-git-path' });
 });
 it('refuses invalid UTF-8 filenames instead of aliasing a registered replacement-character path', async () => {
  const f = fixture(); const name = 'src/\uFFFD.ts';
  const registry = structuredClone(f.registry); registry.screens[0].sources.push(name);
  const base = f.commit({ 'docs/design/screens.json': JSON.stringify(registry), [name]: 'export const value = 1;' });
  const oid = f.git('rev-parse', base + ':src/page.ts');
  const rawPath = Buffer.concat([Buffer.from('src/'), Buffer.from([255]), Buffer.from('.ts')]);
  const head = f.commitObjects([{ path: rawPath, mode: '100644', oid }]);
  expect(await inspectDesignGitTrees({ repo: f.root, base, head })).toMatchObject({ status: 'unavailable', code: 'git-output-not-utf8' });
 });
 it('reports an over-budget policy blob as unavailable', async () => {
  const f = fixture(); const head = f.commit({ 'docs/DESIGN-STANDARD.md': 'x'.repeat(2 * 1024 * 1024 + 1) });
  expect(await inspectDesignGitTrees({ repo: f.root, base: f.base, head })).toMatchObject({ status: 'unavailable', code: 'git-read-failed' });
 });

 it('refuses a complete diff exceeding the declared changed-path budget', async () => {
  const f = fixture(); const oid = f.git('rev-parse', f.base + ':dashboard/accounts.js');
  const head = f.commitObjects(Array.from({ length: 2001 }, (_, i) => ({ path: Buffer.from(`dashboard/new-${i}.html`), mode: '100644', oid })));
  expect(await inspectDesignGitTrees({ repo: f.root, base: f.base, head })).toMatchObject({ status: 'unavailable', code: 'diff-capacity' });
 });
 it('bounds aggregate source reads before retaining many individually permitted blobs', async () => {
  const f = fixture(); const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`src/large-${i}.ts`] = '// invented source '+i+'\n'+'x'.repeat(1900000);
  const head = f.commit(files);
  const r = await inspectDesignGitTrees({ repo: f.root, base: f.base, head });
  expect(r.status).toBe('unavailable');
 });
 it('does not inherit repository or object-directory redirection from its caller', async () => {
  const f = fixture(); const old = process.env.GIT_DIR;
  process.env.GIT_DIR = '/nonexistent-design-inspection-git-dir';
  try { expect((await inspectDesignGitTrees({ repo: f.root, base: f.base, head: f.base })).status).toBe('structurally-valid'); }
  finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
 });

 it('preserves a leading BOM character in a literal Git filename', async () => {
  const f = fixture(); const name = '\uFEFFdashboard/accounts.js'; const head = f.commit({ [name]: '<html>Distinct literal source file</html>' });
  const r = await inspectDesignGitTrees({ repo: f.root, base: f.base, head });
  expect(r.status).toBe('findings');
  if ('classification' in r) { expect(r.changedPaths).toContain(name); expect(r.classification.unregistered).toContain(name); }
 });

 it('optionally reads complete feedback structure/history from both committed trees', async () => {
  const f = fixture(); const file = 'docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md';
  const base = f.commit({ [file]: fs.readFileSync(file, 'utf8') });
  const r = await inspectDesignGitTrees({ repo: f.root, base, head: base, feedback: true });
  expect(r.status).toBe('structurally-valid');
  expect(r).toHaveProperty('feedback.sourceVerification', false);
  expect(r).toHaveProperty('feedback.publicationPrivacyReview', false);
  expect(r).toHaveProperty('feedback.errors', []);
 });
 it('does not let deletion of a committed feedback entry disappear in the optional preview', async () => {
  const f = fixture(); const file = 'docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md';
  const base = f.commit({ [file]: fs.readFileSync(file, 'utf8') });
  f.git('rm', '--', file); f.git('commit', '-qm', 'Synthetic removed entry');
  const r = await inspectDesignGitTrees({ repo: f.root, base, head: 'HEAD', feedback: true });
  expect(r.status).toBe('findings');
  if ('findings' in r) expect(r.findings).toContainEqual(expect.objectContaining({ code: 'feedback:entry-history-removed', entryId: 'DF-0001' }));
 });
 it('reports a non-entry public file without reading its potentially private binary bytes', async () => {
  const f = fixture(); const file = 'docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md';
  const base = f.commit({ [file]: fs.readFileSync(file, 'utf8') });
  const head = f.commit({ 'docs/design-feedback/private-capture.png': 'PRIVATE-PIXEL-CONTENT-MUST-NOT-BE-IN-REPORT' });
  const r = await inspectDesignGitTrees({ repo: f.root, base, head, feedback: true });
  expect(r.status).toBe('findings'); expect(JSON.stringify(r)).not.toContain('PRIVATE-PIXEL-CONTENT-MUST-NOT-BE-IN-REPORT');
  if ('findings' in r) expect(r.findings).toContainEqual(expect.objectContaining({ code: 'feedback:entry-path-invalid' }));
 });
 it('never follows a feedback entry symlink while collecting the committed corpus', async () => {
  const f = fixture(); fs.symlinkSync('/etc/passwd', path.join(f.root, 'linked-entry'));
  f.git('add', '--', 'linked-entry'); f.git('commit', '-qm', 'Synthetic feedback link');
  const oid = f.git('rev-parse', 'HEAD:linked-entry');
  const head = f.commitObjects([{ path: Buffer.from('docs/design-feedback/DF-0001-linked.md'), mode: '120000', oid }]);
  expect(await inspectDesignGitTrees({ repo: f.root, base: f.base, head, feedback: true })).toMatchObject({ status: 'unavailable', code: 'non-regular-feedback-entry' });
 });

});
