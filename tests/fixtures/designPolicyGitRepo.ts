import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { designRuleLockForStandard, designStandardForEntries } from './designStandardForEntries.js';
export function createDesignPolicyGitRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-policy-fixture-')));
  const git = (...args: string[]) => SafeGitExecutor.run(args, { cwd: root, operation: 'tests/design-policy-git-fixture', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Design Policy Test'); git('config', 'user.email', 'design@example.com');
  // The fixture commits only DF-0001, so the standard and its id lock keep only the rules that entry (or no entry) earned.
  const standard = designStandardForEntries(fs.readFileSync(new URL('../../docs/DESIGN-STANDARD.md', import.meta.url), 'utf8'), ['DF-0001']);
  const lock = designRuleLockForStandard(fs.readFileSync(new URL('../../docs/design/rule-ids.lock.json', import.meta.url), 'utf8'), standard);
  const registry = { version: 1, screens: [{ id: 'accounts', title: 'Accounts', mainQuestion: 'Which account has room?', surface: 'Web', route: '/accounts', sources: ['dashboard/accounts.js'], shared: [], capture: 'uncaptured', trackedBy: 'CMT-2169' }] };
  const write = (file: string, contents: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); };
  const commit = (files: Record<string, string>) => {
    for (const [file, contents] of Object.entries(files)) write(file, contents);
    git('add', '--', ...Object.keys(files)); git('commit', '-qm', 'Synthetic design policy fixture');
    return git('rev-parse', 'HEAD');
  };
  const base = commit({ 'docs/DESIGN-STANDARD.md': standard, 'docs/design/rule-ids.lock.json': lock,
    'docs/design/screens.json': JSON.stringify(registry), 'dashboard/accounts.js': 'export const title = "Accounts";',
    'src/page.ts': 'export const page = "<!doctype html><html>Page</html>";' });
  // Build exact synthetic Git tree bytes through existing object-writing verbs.
  // This supports invalid filename bytes without checkout or a new update-index authority.
  const commitObjects = (additions: Array<{ path: Buffer; mode: string; oid: string }>) => {
    type Entry = { name: Buffer; mode?: string; oid?: string; children: Map<string, Entry> };
    const tree: Entry = { name: Buffer.alloc(0), children: new Map() };
    const put = (file: Buffer, mode: string, oid: string) => {
      let parent = tree; let offset = 0;
      for (let i = 0; i <= file.length; i++) if (i === file.length || file[i] === 47) {
        const name = file.subarray(offset, i), key = name.toString('hex'); offset = i + 1;
        const entry = parent.children.get(key) ?? { name, children: new Map<string, Entry>() };
        parent.children.set(key, entry);
        if (i === file.length) { entry.mode = mode; entry.oid = oid; }
        parent = entry;
      }
    };
    for (const line of git('ls-tree', '-rz', 'HEAD').split('\0').filter(Boolean)) {
      const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(line)!;
      put(Buffer.from(match[3]), match[1], match[2]);
    }
    for (const entry of additions) put(entry.path, entry.mode, entry.oid);
    const store = (entry: Entry): string => {
      const children = [...entry.children.values()].sort((a, b) => Buffer.compare(
        Buffer.concat([a.name, Buffer.from(a.children.size ? '/' : '')]), Buffer.concat([b.name, Buffer.from(b.children.size ? '/' : '')])));
      const body = Buffer.concat(children.map(child => Buffer.concat([
        Buffer.from((child.children.size ? '40000' : child.mode!) + ' '), child.name, Buffer.from([0]),
        Buffer.from(child.children.size ? store(child) : child.oid!, 'hex')])));
      return SafeGitExecutor.execSync(['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd: root, operation: 'tests/design-policy-tree-object', input: body }).trim();
    };
    return SafeGitExecutor.execSync(['commit-tree', store(tree), '-p', git('rev-parse', 'HEAD'), '-m', 'Synthetic exact tree'],
      { cwd: root, operation: 'tests/design-policy-tree-commit' }).trim();
  };
  return { root, git, write, commit, commitObjects, base, standard, lock, registry,
    cleanup: () => SafeFsExecutor.safeRmTreeSerial(root, { operation: 'tests/design-policy-fixture-cleanup' }) };
}
