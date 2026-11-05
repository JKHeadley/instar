import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const lint = path.resolve('scripts/lint-notification-selectivity.mjs');
function check(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-census-'));
  try {
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'src', 'newProducer.ts'), source);
    fs.writeFileSync(path.join(root, 'scripts', 'notification-selectivity-raw-baseline.json'), '{}');
    return spawnSync(process.execPath, [lint], { cwd: root, encoding: 'utf8' });
  } finally { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'notification census fixture' }); }
}
describe('notification producer census ratchet', () => {
  it('accepts only a source-bound routine stamper for a new producer', () => {
    expect(check("const stamp = notificationStamper('src/newProducer.ts'); withNotificationEnvelope(stamp(), () => telegram.sendToTopic(42, 'routine')); ").status).toBe(0);
  });
  it.each([
    "telegram.sendToTopic(42, 'unstamped');",
    "telegram.sendToTopic(42, 'borrowed', { envelope: { origin: 'verified-reply' } });",
    "withNotificationEnvelope({ origin: 'automated', category: 'attention-item', significantClass: 'data-loss' }, () => telegram.sendToTopic(42, 'forged'));",
    "const stamp = notificationStamper('src/commands/server.ts'); withNotificationEnvelope(stamp(), () => telegram.sendToTopic(42, 'borrowed'));",
    'telegram.apiCall("sendMessage", {});',
    "notificationContext.run(reply, () => telegram.sendToTopic(42, 'ambient'));",
  ])('rejects an unregistered egress or borrowed capability: %s', source => {
    expect(check(source).status).toBe(1);
  });
});
