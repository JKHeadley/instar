import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const lint = path.resolve('scripts/lint-notification-selectivity.mjs');
function check(source: string, rel = 'src/newProducer.ts') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-census-'));
  try {
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), source);
    fs.writeFileSync(path.join(root, 'scripts', 'notification-selectivity-raw-baseline.json'), '{}');
    return spawnSync(process.execPath, [lint], { cwd: root, encoding: 'utf8' });
  } finally { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'notification census fixture' }); }
}
describe('notification producer census ratchet', () => {
  it('accepts only a source-bound routine stamper for a new producer', () => {
    expect(check("const stamp = notificationStamper('src/newProducer.ts'); withNotificationEnvelope(stamp(), () => telegram.sendToTopic(42, 'routine')); ").status).toBe(0);
  });
  it('restricts the human mirror capability to its admitted route, never the shared helper', () => {
    const mirror = "withNotificationEnvelope(verifiedInboundMirrorEnvelope('native'), () => telegram.sendToTopic(42, 'copy'));";
    expect(check("router.post('/mobile/chat/:topicId', async () => { " + mirror + " });", 'src/server/mobilePairingRoutes.ts').status).toBe(0);
    expect(check(mirror, 'src/server/mobilePairingRoutes.ts').status).toBe(1);
    expect(check("router.post('/mobile/pairing-codes/redeem', async () => { " + mirror + " });", 'src/server/mobilePairingRoutes.ts').status).toBe(1);
    expect(check(mirror, 'src/server/mobileMediaSend.ts').status).toBe(1);
  });
  it.each([
    "telegram.sendToTopic(42, 'unstamped');",
    "telegram.sendMediaToTopic(42, [], null);",
    "telegram.sendToTopic(42, 'borrowed', { envelope: { origin: 'verified-reply' } });",
    "withNotificationEnvelope({ origin: 'automated', category: 'attention-item', significantClass: 'data-loss' }, () => telegram.sendToTopic(42, 'forged'));",
    "const stamp = notificationStamper('src/commands/server.ts'); withNotificationEnvelope(stamp(), () => telegram.sendToTopic(42, 'borrowed'));",
    'telegram.apiCall("sendMessage", {});',
    "const stamp = notificationStamper('src/newProducer.ts', 'spend-alert-dispatcher'); withNotificationEnvelope(stamp(), () => telegram.sendToTopic(42, 'borrowed'));",
    "notificationContext.run(reply, () => telegram.sendToTopic(42, 'ambient'));",
  ])('rejects an unregistered egress or borrowed capability: %s', source => {
    expect(check(source).status).toBe(1);
  });
});
