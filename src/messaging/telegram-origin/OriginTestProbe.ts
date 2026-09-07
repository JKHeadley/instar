import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { MachineIdentityManager } from '../../core/MachineIdentity.js';
import { mergeConfigWithSecrets } from '../../core/SecretMigrator.js';
import { TelegramOriginRuntime } from './TelegramOriginRuntime.js';
import { telegramFetch } from '../telegram-egress.js';

/** A standalone test CLI has no session author. Its fixed probe retains origin
 * in the already validated test home, which teardown leaves for inspection. */
export async function sendRecordedTestProbe(input: { projectDir: string; botToken: string; chatId: number;
  nonce: string; timeoutMs: number; workerUrl?: URL }): Promise<void> {
  if (!Number.isSafeInteger(input.chatId) || !/^n[a-z0-9]{1,64}$/.test(input.nonce)) throw new Error('invalid-test-probe');
  const stateDir = path.join(input.projectDir, '.instar');
  const config: Record<string, any> = mergeConfigWithSecrets(JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8')), stateDir);
  if (typeof config.projectName !== 'string' || !config.projectName) throw new Error('test-probe-agent-identity-unavailable');
  const identities = new MachineIdentityManager(stateDir);
  // init/server owns identity creation. Never create a replacement identity to
  // make a missing-key test send appear to have durable original attribution.
  const identity = identities.loadIdentity();
  const machineName = identities.loadRegistry().machines[identity.machineId]?.nickname ?? `Machine ${identity.machineId.slice(0, 8)}`;
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: config.projectName }, workerUrl: input.workerUrl,
    identity: { agentId: config.projectName, agentName: config.projectName, originMachineId: identity.machineId, originMachineName: machineName },
    signingKey: { keyId: `${identity.machineId}:${identity.keyEpoch ?? 0}`, keyEpoch: identity.keyEpoch ?? 0, privateKey: identities.loadSigningKey() },
    bot: { token: input.botToken, accountId: input.botToken.split(':')[0] },
    display: () => ({ agent: config.messaging?.find((item: { type: string }) => item.type === 'telegram')?.config?.messageOrigin?.display }),
    authorize: request => request.method === 'sendMessage' && request.destination.chatId === String(input.chatId),
    alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined,
    diagnosticMode: 'delegate',
    diagnoseUnknown: async (originId, reason) => {
      if (!config.authToken || !Number.isSafeInteger(config.port)) throw new Error('test-probe-supervisor-unavailable');
      const response = await fetch(`http://127.0.0.1:${config.port}/telegram/origins/diagnose`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.authToken}`, 'X-Instar-AgentId': config.projectName },
        body: JSON.stringify({ originId, reason }), signal: AbortSignal.timeout(30_000) });
      if (response.status !== 202) throw new Error('test-probe-supervisor-unavailable');
    },
  });
  try {
    runtime.service.registerAutomationProducer('test-as-self');
    await runtime.service.runAsAutomation('test-as-self', async () => {
      await telegramFetch(`https://api.telegram.org/bot${input.botToken}/sendMessage`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: input.chatId, text: `test-as-self ${input.nonce}` }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, input.timeoutMs))) });
    });
  } finally { await runtime.close(); }
}
