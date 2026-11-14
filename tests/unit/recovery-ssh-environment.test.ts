import {afterEach,describe,expect,it} from 'vitest';import {execFileSync} from 'node:child_process';
import {RecoveryEnrollment} from '../../src/recovery/RecoveryEnrollment.js';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {qualifyRecoverySshEnvironment,validateRecoverySshEnvironment} from '../../src/recovery/RecoverySshEnvironment.js';
import {recoveryKeyPair} from '../../src/recovery/RecoveryProtocol.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const safe='acceptenv LANG\nacceptenv LC_*\npermituserenvironment no\nforcecommand none\n';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))SafeFsExecutor.safeRmSync(d,{recursive:true,force:true,operation:'recovery-ssh-environment.test:cleanup'});});
describe('effective host sshd environment qualification',()=>{
 it('runs the actual generated forced wrapper with hostile startup variables removed and its selector literal',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-wrapper-env-'));dirs.push(d);const marker=path.join(d,'injected'),probe=path.join(d,'probe.cjs'),preload=path.join(d,'preload.cjs');
  fs.writeFileSync(preload,"require('node:fs').writeFileSync("+JSON.stringify(marker)+",'executed');");
  fs.writeFileSync(probe,"process.stdout.write(JSON.stringify({env:process.env,args:process.argv.slice(2)}))");
  const configFile=path.join(d,'host.json'),selector='$(touch '+marker+'); literal selector';
  const writer=(RecoveryEnrollment.prototype as unknown as {writeWrapper:(this:unknown,c:unknown,f:string)=>void}).writeWrapper;
  writer.call({directory:d,o:{agentHome:d,username:'fixture'}},{runtimeSlot:{node:process.execPath,entrypoint:probe}},configFile);
  const result=JSON.parse(execFileSync('/bin/sh',[path.join(d,'ssh-wrapper.sh')],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'--require='+preload,NODE_PATH:d,BASH_ENV:preload,ENV:preload,SSH_ORIGINAL_COMMAND:selector}}));
  expect(fs.existsSync(marker)).toBe(false);expect(result.env.SSH_ORIGINAL_COMMAND).toBe(selector);expect(result.args).toEqual(['ssh',configFile]);
  for(const name of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV'])expect(result.env[name]).toBeUndefined();expect(result.env.HOME).toBe(d);
 });
 it('allows only language settings without user environment or a global forced-command override',()=>{expect(()=>validateRecoverySshEnvironment(safe)).not.toThrow();expect(()=>validateRecoverySshEnvironment('permituserenvironment no\nforcecommand none\n')).not.toThrow();});
 it.each(['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV','ZDOTDIR','LD_PRELOAD','DYLD_INSERT_LIBRARIES','*','LANG*'])('refuses client-controlled startup variable %s',variable=>{expect(()=>validateRecoverySshEnvironment(safe+'acceptenv '+variable+'\n')).toThrow('policy-unsafe');});
 it('refuses sshd SetEnv shell startup variables even when AcceptEnv is safe',()=>{expect(()=>validateRecoverySshEnvironment(safe+'setenv BASH_ENV=/tmp/untrusted\n')).toThrow('policy-unsafe');expect(()=>validateRecoverySshEnvironment(safe+'setenv LC_ALL=C\n')).not.toThrow();});
 it('refuses unknown policy, user environment processing and overriding ForceCommand',()=>{for(const policy of ['acceptenv LANG\n',safe.replace('permituserenvironment no','permituserenvironment yes'),safe.replace('forcecommand none','forcecommand /bin/sh')])expect(()=>validateRecoverySshEnvironment(policy)).toThrow();});
 it('reads all trusted includes and uses a private inspection key without touching the real host key or daemon',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-sshd-policy-'));dirs.push(d);const configFile=path.join(d,'sshd_config'),hostKeyFile=path.join(d,'inspection-key');fs.mkdirSync(path.join(d,'conf.d'),{mode:0o700});
  fs.writeFileSync(configFile,'Include '+path.join(d,'conf.d','*.conf')+'\n',{mode:0o600});const included=path.join(d,'conf.d','safe.conf');fs.writeFileSync(included,'AcceptEnv LANG LC_*\nPermitUserEnvironment no\n',{mode:0o600});fs.writeFileSync(hostKeyFile,recoveryKeyPair().privateKey,{mode:0o600});
  let called=false;const result=qualifyRecoverySshEnvironment({configFile,hostKeyFile,run:args=>{called=true;expect(args).toEqual(['-T','-f',configFile,'-h',hostKeyFile]);return safe;}});expect(called).toBe(true);expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  fs.writeFileSync(included,'Match User other\n  AcceptEnv BASH_ENV\n');called=false;expect(()=>qualifyRecoverySshEnvironment({configFile,hostKeyFile,run:()=>{called=true;return safe;}})).toThrow('unqualified-match');expect(called).toBe(false);
  fs.writeFileSync(included,'AcceptEnv NODE_OPTIONS\n');expect(()=>qualifyRecoverySshEnvironment({configFile,hostKeyFile,run:()=>safe})).toThrow('policy-unsafe');
  fs.writeFileSync(included,'AcceptEnv LANG\n');fs.chmodSync(included,0o666);expect(()=>qualifyRecoverySshEnvironment({configFile,hostKeyFile,run:()=>safe})).toThrow('policy-unknown');
 });
});
