/** Read-only regression against the actual checked-out Instar source tree. */
import {describe,it,expect,vi,afterEach} from 'vitest';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import {SafeGitExecutor} from '../../src/core/SafeGitExecutor.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
afterEach(()=>vi.restoreAllMocks());
describe('ScopeVerifier reads evidence without dropping the source-tree remote gate',()=>{
 it('reads the real origin using only the supported hard-coded read, and still blocks a wrong project',()=>{
  const actual=SafeGitExecutor.readSync(['remote','get-url','origin'],{cwd:root,sourceTreeReadOk:true,operation:'scope-regression:readonly-origin'}).trim();
  expect(actual.length).toBeGreaterThan(0);
  const read=vi.spyOn(SafeGitExecutor,'readSync');
  const gate=new ScopeVerifier({projectDir:root,stateDir:path.join(root,'.instar'),projectName:'instar',expectedGitRemote:actual});
  const result=gate.check('git-push');
  expect(result.checks.find(check=>check.name==='git-remote')?.passed).toBe(true);
  expect(read).toHaveBeenCalledWith(['remote','get-url','origin'],expect.objectContaining({cwd:root,sourceTreeReadOk:true}));
  const wrong=new ScopeVerifier({projectDir:root,stateDir:path.join(root,'.instar'),projectName:'instar',expectedGitRemote:'https://github.com/unrelated-owner/unrelated-project.git'});
  const refused=wrong.check('git-push');
  expect(refused.checks.find(check=>check.name==='git-remote')?.passed).toBe(false);
  expect(refused.recommendation).toBe('block');
 });
});
