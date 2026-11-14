import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

describe('development release entry points', () => {
  it('exposes explicit pack/install commands and rejects missing target homes', () => {
    const result = spawnSync(process.execPath, ['scripts/development-release.mjs', 'install', '/tmp/no-target'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('AGENT_HOME');
  });

  it('refuses a dirty release cut before touching package version or building', () => {
    // This checkout is normally clean in CI. Use a disposable git repo with
    // just the script, since this test is about its real admission boundary.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
      import {execFileSync,spawnSync} from 'node:child_process';
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dev-release-contract-'));
      try {
        fs.mkdirSync(path.join(dir,'scripts')); fs.copyFileSync('scripts/development-release.mjs',path.join(dir,'scripts/development-release.mjs'));
        fs.writeFileSync(path.join(dir,'package.json'),'{}');
        const git=(a)=>execFileSync('git',a,{cwd:dir,stdio:'pipe'});
        git(['init']); git(['add','package.json']);
        git(['-c','user.name=Test','-c','user.email=test@instar.local','commit','-m','initial']);
        fs.writeFileSync(path.join(dir,'package.json'),'changed');
        const result=spawnSync(process.execPath,[path.join(dir,'scripts/development-release.mjs'),'pack',path.join(dir,'out')],{encoding:'utf8'});
        process.stdout.write(JSON.stringify({status:result.status,error:result.stderr,package:fs.readFileSync(path.join(dir,'package.json'),'utf8')}));
      } finally {fs.rmSync(dir,{recursive:true,force:true});}
    `], { encoding: 'utf8' });
    const result = JSON.parse(output);
    expect(result.status).not.toBe(0);
    expect(result.error).toContain('clean source revision');
    expect(result.package).toBe('changed');
  });

  it('publishes immutable prerelease assets with no npm account auth', () => {
    const workflow = fs.readFileSync('.github/workflows/development-release.yml', 'utf8');
    expect(workflow).toContain('ref: main');
    expect(workflow).toContain('development-release.mjs pack');
    expect(workflow).toContain('--target "$sha" --prerelease');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toMatch(/run:.*npm publish/);
    expect(workflow).not.toContain('--clobber');
  });
});
