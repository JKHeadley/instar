/** Standalone compiled entrypoints; never imports the main server or session manager. */
import crypto from 'node:crypto';
import { recoveryResponseJson } from './RecoveryHttp.js';
import { RecoveryAdmission } from './RecoveryAdmission.js';
import { LaunchdRecoveryControl, RecoveryEngine, loadRecoveryConfig, recoveryHostBootId } from './RecoveryEngine.js';
import { signRecovery } from './RecoveryProtocol.js';

export async function openRecoveryEngine(file: string, options: { restorationOnly?: boolean } = {}): Promise<RecoveryEngine> {
  const config = loadRecoveryConfig(file, options); const bootId = await recoveryHostBootId();
  const admission = new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,bootId,certificationRoot:config.certificationRoot});
  return new RecoveryEngine(config,admission,bootId,new LaunchdRecoveryControl(config));
}
export async function recoverySshMain(configFile: string): Promise<void> {
  const command = process.env.SSH_ORIGINAL_COMMAND;
  if (!['instar-recovery-v1','instar-recovery-hello-v1','instar-recovery-checkpoint-challenge-v1','instar-recovery-checkpoint-deliver-v1'].includes(command??'')) throw new Error('recovery-ssh-command-refused');
  // Checkpoint carry must remain possible after a main-service update or lease
  // expiry; it authorizes no mutation and always verifies the authority signature.
  const engine = await openRecoveryEngine(configFile,{restorationOnly:command?.startsWith('instar-recovery-checkpoint-')});
  try {
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(()=>process.stdin.destroy(new Error('recovery-input-timeout')),3_000);
    try {
      for await (const chunk of process.stdin) { size += chunk.length; if (size > 16_384) throw new Error('recovery-input-too-large'); chunks.push(Buffer.from(chunk)); }
    } finally { clearTimeout(timer); }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const response = command === 'instar-recovery-checkpoint-challenge-v1' ? engine.checkpointForCarrier(request)
      : command === 'instar-recovery-checkpoint-deliver-v1' ? engine.acceptCarriedCheckpoint(request)
      : command === 'instar-recovery-hello-v1' ? engine.hello(request,'ssh') : await engine.execute(request,'ssh');
    process.stdout.write(JSON.stringify(response)+'\n');
  } finally { engine.admission.close(); }
}
export async function recoverySidecarMain(configFile: string, signal: AbortSignal): Promise<void> {
  const engine = await openRecoveryEngine(configFile); const c = engine.config;
  const request = async (action: string, body: Record<string, unknown>) => {
    const now = Date.now();
    const signed = signRecovery({domain:'instar-recovery-control-request-v1',agentId:c.agentId,machineId:c.machineId,action,nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30_000,body},c.relayPrivateKey);
    const response = await fetch(new URL(`/v1/recovery/${action}`,c.relayUrl),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(signed),signal:AbortSignal.any([signal,AbortSignal.timeout(5_000)]),redirect:'error'});
    if (!response.ok) { await response.body?.cancel(); throw new Error('recovery-control-request-failed'); } return recoveryResponseJson(response);
  };
  let checkpointAt = 0;
  try {
    while (!signal.aborted) {
      if (Date.now() >= checkpointAt) {
        // Renewal failure must not suppress the independent mailbox while the
        // previously accepted offline lease remains usable.
        checkpointAt = Date.now()+60_000;
        try {
          const updated = await request('checkpoint',{challenge:engine.admission.challenge()});
          engine.admission.acceptCheckpoint(updated.certificate,updated.checkpoint);
          const checkpointVersion=engine.reconcileCheckpointRevocations();
          await request('checkpoint-ack',{checkpointVersion});
        } catch { engine.admission.audit('checkpoint-renewal-failed'); }
      }
      try {
        const poll = await request('poll',{});
        for (const frame of poll.frames) {
          try {
            const signed = JSON.parse(frame.payload);
            // Source clients share this mailbox with the listener. Responses are
            // verified/acknowledged only by their nonce-bound waiting client.
            if(['instar-recovery-receipt-v1','instar-recovery-hello-v1'].includes(signed?.payload?.domain))continue;
            // End-to-end target policy verifies the source; the relay has no execution authority.
            const response = signed?.payload?.domain === 'instar-recovery-discovery-v1' ? engine.hello(signed,'relay') : await engine.execute(signed,'relay');
            await request('send',{to:frame.from,id:crypto.randomUUID(),payload:JSON.stringify(response)});
            await request('ack',{id:frame.id});
          } catch { engine.admission.audit('relay-operation-refused'); }
        }
      } catch { engine.admission.audit('relay-poll-failed'); }
      await new Promise<void>(resolve=> {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); };
        const timer = setTimeout(done,1_000); signal.addEventListener('abort',done,{once:true});
      });
    }
  } finally { engine.admission.close(); }
}
