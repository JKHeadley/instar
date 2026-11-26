/** Run explicitly on the designated Darwin trial host, using built trialExecutionScope.js. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { TrialExecutionScope, reconcileTrialScopes, darwinTrialScope } from '../../dist/localVerify/trialExecutionScope.js';

import { readSmallPeerMemory } from '../../dist/localVerify/smallPeerMemory.js';

const epoch = performance.now();
const attempt = randomBytes(16).toString('hex');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-trial-scope-'));
const plist = path.join(stateDir, 'fixture.plist');
const label = TrialExecutionScope.prepare(stateDir, attempt);
const py = '/usr/bin/python3';
const report = {attempt, stateDir, label, explicitAllocationBytes: 8 * 1024 * 1024, hostAvailable: [], samples: []};
async function sampleHost() {
  const sample = await readSmallPeerMemory();
  if (!sample || sample.pressureLevel !== 1) throw new Error('Healthy native memory counters unavailable');
  report.hostAvailable.push({...sample, wallMs:Math.round(performance.now()-epoch)});
}
async function marker(name) {
  const dest = path.join(stateDir,name);
  const deadline = performance.now() + 5000;
  while (!fs.existsSync(dest) && performance.now() < deadline) await wait(50);
  return Number(fs.readFileSync(dest,'utf8'));
}
const fixture = `import os,signal,sys,time
from pathlib import Path
folder=Path(sys.argv[1])
signal.signal(signal.SIGALRM,signal.SIG_DFL)
signal.alarm(20)
def mark(name):
    p=folder/(name+'.tmp')
    p.write_text(str(os.getpid()))
    p.replace(folder/name)
# A KeepAlive relaunch is fenced from starting workload even after root death.
if (folder/'root').exists():
    mark('relaunch')
    time.sleep(15)
    sys.exit(0)
mark('root')
while not (folder/'release').exists():
    time.sleep(.04)
if os.fork()==0:
    os.setsid()
    if os.fork()!=0: os._exit(0)
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    signal.alarm(18)
    memory=bytearray(8*1024*1024)
    for i in range(0,len(memory),4096): memory[i]=1
    mark('orphan')
    time.sleep(14)
    os._exit(0)
os.wait()
time.sleep(14)`;
fs.writeFileSync(path.join(stateDir,'fixture.py'),fixture,{mode:0o600});
execFileSync(py,['-I','-c',`import plistlib,sys
from pathlib import Path
folder=Path(sys.argv[1])
with open(folder/'fixture.plist','wb') as f:
    plistlib.dump(dict(Label=sys.argv[2],ProgramArguments=['/usr/bin/python3','-I',str(folder/'fixture.py'),str(folder)],RunAtLoad=True,KeepAlive=True,ThrottleInterval=2,ExitTimeOut=1,AbandonProcessGroup=False),f)`,stateDir,label]);
let bootstrapped=false, timer;
try {
  await sampleHost();
  execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plist],{timeout:3000});
  bootstrapped=true;
  const root=await marker('root');
  const scope=TrialExecutionScope.capture({stateDir,attemptId:attempt,rootPid:root});
  report.beforeAllocationRssBytes=scope.sample().rssBytes;
  fs.writeFileSync(path.join(stateDir,'release'),'1');
  const orphan=await marker('orphan');
  const ppid=Number(execFileSync('/bin/ps',['-p',String(orphan),'-o','ppid='],{encoding:'utf8'}).trim());
  if(ppid!==1) throw new Error('fixture worker was not reparented');
  for(let i=0;i<3;i++){
    await sampleHost();
    const s=scope.sample();
    if(!s.members.some(m=>m.pid===orphan && m.rssBytes>=report.explicitAllocationBytes)) throw new Error('worker allocation missing');
    report.samples.push({wallMs:Math.round(performance.now()-epoch),rssBytes:s.rssBytes,pids:s.members.map(x=>x.pid)});
    await wait(100);
  }
  report.reconcileStartMs=Math.round(performance.now()-epoch);
  const observations=[];
  timer=setInterval(() => observations.push(sampleHost().catch(e => { report.measurementError=String(e); })),100);
  // Drop the captured scope. Recovery has only the durable identity and host kernel evidence.
  await reconcileTrialScopes(stateDir);
  clearInterval(timer);
  await Promise.all(observations);
  if(report.measurementError) throw new Error(report.measurementError);
  report.reconcileEndMs=Math.round(performance.now()-epoch);
  await sampleHost();
  report.labelAbsent=darwinTrialScope.job(label)===null;
  report.closed=JSON.parse(fs.readFileSync(path.join(stateDir,'trial-scopes',attempt+'.json'),'utf8')).closed;
  if(!report.labelAbsent || !report.closed) throw new Error('startup reconciliation left custody open');
  report.attemptPeakSampledRssBytes=Math.max(...report.samples.map(s=>s.rssBytes));
  report.minimumObservedAvailableBytes=Math.min(...report.hostAvailable.map(s=>s.availableBytes));
  report.elapsedMs=Math.round(performance.now()-epoch);
  report.ok=true;
} catch (e) {
  report.error=e instanceof Error?e.message:String(e);
  process.exitCode=1;
} finally {
  clearInterval(timer);
  if(bootstrapped && darwinTrialScope.job(label)) {
    try {execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{timeout:3000});}
    catch(e){report.cleanupError=String(e);process.exitCode=1;}
  }
  // The fixture's bounded orphan exits independently if the tested cleanup failed.
  console.log(JSON.stringify(report));
}
