/** Real orchestrator/filesystem/child-output path; Git and package install are controlled boundaries. */
import fs from 'node:fs';
import path from 'node:path';
import { runVerify, verifyPaths, type OrchestratorSeams, type VerifyRunInput } from '../../src/localVerify/orchestrator.js';
import { realSeams, realExec } from '../../src/localVerify/orchestratorSeams.js';

export const DIAGNOSTIC_HEAD = 'a'.repeat(40);
export const DIAGNOSTIC_BASE = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const COMMIT = 'd'.repeat(40);
const TESTS = ['tests/unit/a.test.ts', 'tests/integration/b.test.ts', 'tests/e2e/c.test.ts'];
const PKG = JSON.stringify({ name: 'owned-verifier-fixture', scripts: {}, devDependencies: { vitest: '^2.1.9' } });

export function verificationDiagnosticsFixture(home: string, fail: boolean) {
  const p = verifyPaths(home, DIAGNOSTIC_HEAD);
  const logs: Array<Record<string, unknown>> = [];
  const real = realSeams(event => logs.push(event), p.verifyRoot);
  const script = path.join(home, 'owned-lane.mjs');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(script, `import fs from 'node:fs';
const [output, lane, name, failing, empty] = process.argv.slice(2);
const bad = failing === 'yes' && lane === 'unit' && empty !== 'yes';
const testResults = empty === 'yes' ? [] : [{ name, status: bad ? 'failed' : 'passed', message: '',
  failureMessage: bad ? 'HookInitializationError: owned native fixture stalled' : undefined,
  assertionResults: bad ? [] : [{ status: 'passed', fullName: 'owned case', title: 'owned case' }] }];
fs.writeFileSync(output, JSON.stringify({ testResults }));
if(process.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE) fs.writeFileSync(process.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE,
  JSON.stringify({ v:1, unhandledErrors:bad?1:0, messages:bad?['OwnedUnhandledError: native fixture did not initialize']:[] }));
if(bad) { console.error('NativeFixtureError: detailed failure survived child exit'); process.exitCode=1; }
`);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', timedOut: false });
  const seams: OrchestratorSeams = {
    ...real,
    holdSuiteSlot: undefined, // No nested suites are executed: only the owned one-shot child above.
    foreignSuiteHolders: () => [],
    unhandledErrorsReporter: () => '/owned/trusted-reporter.js',
    git: async args => {
      switch (args[0]) {
        case 'init':
          for (const sub of ['objects', 'refs']) fs.mkdirSync(path.join(p.bare, sub), { recursive: true });
          fs.writeFileSync(path.join(p.bare, 'HEAD'), 'ref: refs/heads/main');
          return ok();
        case 'merge-tree': return ok(TREE + '\n');
        case 'commit-tree': return ok(COMMIT + '\n');
        case 'worktree':
          if (args[1] === 'add') {
            fs.mkdirSync(p.runDir, { recursive: true });
            const admin = path.join(p.bare, 'worktrees', path.basename(p.runDir));
            fs.mkdirSync(admin, { recursive: true });
            fs.writeFileSync(path.join(p.runDir, '.git'), `gitdir: ${admin}\n`);
            fs.writeFileSync(path.join(p.runDir, 'package.json'), PKG);
          }
          if (args[1] === 'remove') await real.fs.removeTree(args[2]);
          return ok();
        case 'merge-base': return ok(DIAGNOSTIC_BASE + '\n');
        case 'diff': return ok('M\tsrc/owned-fixture.ts\n');
        case 'ls-tree': return ok(['package.json', ...TESTS].join('\n') + '\n');
        case 'show': return ok(args[1]?.endsWith(':package.json') ? PKG : 'export const ownedFixture = true;');
        default: return ok();
      }
    },
    exec: async (command, args, opts) => {
      if (command === 'npm' || command === 'sh') return { status: 0, signal: null, stdout: '', stderr: '', deadlineKilled: false, pid: null };
      const output = args.find(a => a.startsWith('--outputFile='))?.slice('--outputFile='.length);
      if (!output) throw new Error('Owned fixture received an unexpected process command');
      const config = args[args.indexOf('--config') + 1];
      const lane = config.includes('integration') ? 'integration' : config.includes('e2e') ? 'e2e' : 'unit';
      const shard = args.find(a => a.startsWith('--shard='));
      const empty = shard && !shard.startsWith('--shard=1/') ? 'yes' : 'no';
      const file = TESTS.find(f => f.includes(`/${lane}/`))!;
      return realExec(process.execPath, [script, output, lane, path.join(p.runDir, file), fail ? 'yes' : 'no', empty], opts);
    },
  };
  const input: VerifyRunInput = {
    repo: 'JKHeadley/instar', pr: 7, headSha: DIAGNOSTIC_HEAD, baseSha: DIAGNOSTIC_BASE, baseRefName: 'main', agentHome: home,
    remoteUrl: 'https://example.invalid/owned-fixture.git', nodeVersion: process.version, machineId: 'owned',
    verifierVersion: 'owned-fixture', policyHash: 'f'.repeat(64), protectedList: [], baseEnv: { PATH: process.env.PATH, HOME: home },
    isolation: { allowed: false, notCleanOnGreenMain: [] }, preflightMode: 'off',
    // Only owned one-shot fixture children are executed, never nested test suites.
    laneShards: { integration: 1, e2e: 1, unitWorkers: 1 },
  };
  return { paths: p, seams, input, logs, run: () => runVerify(input, seams) };
}
