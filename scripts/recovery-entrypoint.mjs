#!/usr/bin/env node
import { resumeAbandonedRecoveryFleetUpdate } from '../dist/recovery/RecoveryFleetUpdate.js';
import { resumeAbandonedRecoveryMainUpdate } from '../dist/recovery/RecoveryAutostartUpdate.js';
import { cleanupRecoveryRuntimeSlots } from '../dist/recovery/RecoveryRuntimeSlot.js';
import { admitRecoverySupervisor } from '../dist/recovery/RecoverySupervisor.js';
import { loadRecoveryConfig, LaunchdRecoveryControl } from '../dist/recovery/RecoveryEngine.js';
import { openRecoveryEngine, recoverySidecarMain, recoverySshMain } from '../dist/recovery/RecoveryEntrypoint.js';
const [mode,config] = process.argv.slice(2);
try {
  if(mode==='cleanup-runtime-slots')process.stdout.write(JSON.stringify(cleanupRecoveryRuntimeSlots(config))+'\n');
  else if (mode === 'ssh') await recoverySshMain(config);
  else if (mode === 'sidecar') {
    const abort = new AbortController();
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>abort.abort());
    const c = loadRecoveryConfig(config);
    let budget;
    do {
      budget = admitRecoverySupervisor(c.stateDir, {agentId:c.agentId,machineId:c.machineId,relayUrl:c.relayUrl,certificationRoot:c.certificationRoot,configRevision:process.env.INSTAR_RECOVERY_CONFIG_REVISION??null,runtimeRevision:process.env.INSTAR_RECOVERY_RUNTIME_REVISION??null});
      if (!budget.admitted) await new Promise(resolve => { const done=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5000);abort.signal.addEventListener('abort',done,{once:true}); });
    } while (!budget.admitted && !abort.signal.aborted);
    if (!abort.signal.aborted) await recoverySidecarMain(config,abort.signal);
  } else if (mode === 'watchdog-rule-begin' || mode === 'watchdog-rule-end') {
    const engine=await openRecoveryEngine(config,{restorationOnly:mode==='watchdog-rule-end'});
    try {
      if(mode==='watchdog-rule-begin'){
        if(!engine.admission.locallyActive())process.stdout.write(JSON.stringify({admitted:true,guarded:false}));
        else {new LaunchdRecoveryControl(engine.config).validateOwnedWatchdogRule();process.stdout.write(JSON.stringify({admitted:engine.admission.beginWatchdogRule(Number(process.argv[4])),guarded:true}));}
      }else process.stdout.write(JSON.stringify({released:engine.admission.endWatchdogRule(Number(process.argv[4]))}));
    }finally{engine.admission.close();}
  } else if (mode === 'watchdog-rule-stop') {
    const engine = await openRecoveryEngine(config, { restorationOnly: true });
    try { process.stdout.write(JSON.stringify(engine.stopOwnedWatchdogRuleTarget(process.argv[4]?Number(process.argv[4]):undefined))); } finally { engine.admission.close(); }
  } else if (mode === 'restore') {
    await resumeAbandonedRecoveryMainUpdate(config);
    await resumeAbandonedRecoveryFleetUpdate(config);
    const engine = await openRecoveryEngine(config, { restorationOnly: true });
    try { await engine.restoreExpiredHold(); } finally { engine.admission.close(); }
  } else throw new Error('recovery-mode-refused');
} catch (error) {
  console.error(error instanceof Error && /^recovery-[a-z-]+$/.test(error.message) ? error.message : 'recovery-entrypoint-failed');
  process.exitCode = 1;
}
