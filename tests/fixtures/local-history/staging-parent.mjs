import crypto from 'node:crypto';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { LocalHistoryUploadStaging } from '../../../dist/import/LocalHistoryUploadStaging.js';

const [stateDir, socketPath] = process.argv.slice(2);
const device = { deviceId: 'synthetic-device', deviceKeyHash: 'synthetic-device-key' };
const issuer = { agentId: 'synthetic-agent', machineId: 'synthetic-machine', bootId: 'before-crash',
  origin: 'https://synthetic.example', signingKeyHash: 'a'.repeat(64) };
const stage = new LocalHistoryUploadStaging({ stateDir, issuer: () => issuer,
  principal: request => ({ ...request, ownerUserId: 'synthetic-owner' }),
  disk: () => ({ total: 100 * 1024 ** 3, free: 80 * 1024 ** 3 }),
});
const bytes = Buffer.from('synthetic selected bytes');
const granted = stage.admit(device, { bootId: issuer.bootId, selectionChallenge: stage.challenge(device).challenge,
  selectionRequestId: 'synthetic-request', targetMachineId: issuer.machineId, purpose: 'upload-selected-local-conversations',
  project: '/synthetic/project', files: [{ fileId: 'synthetic-file', source: 'codex', displayName: 'renamed.jsonl',
    expectedSessionId: 'synthetic-session', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] });
stage.write(device, granted.operationId, 'synthetic-file', 0, bytes);
const db = new Database(path.join(stateDir, 'local-history-upload', 'child-custody.sqlite'), { readonly: true, fileMustExist: true });
const { generation } = db.prepare('SELECT generation FROM custody WHERE id = 1').get(); db.close();
const holder = fork(fileURLToPath(new URL('./staging-holder.mjs', import.meta.url)), [], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { LANG: 'C.UTF-8', TZ: 'UTC' },
});
const ready = once(holder, 'message'); holder.send({ token: { stateDir, generation }, socketPath });
await ready;
process.on('message', async message => { if (message === 'stop') { await stage.stop(); process.exit(0); } });
process.send?.({ ready: true, operationId: granted.operationId });
