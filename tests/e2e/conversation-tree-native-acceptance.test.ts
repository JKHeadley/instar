import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makeDevice } from '../helpers/mobileDevice.js';

it('keeps all three conversation-tree routes open for a simulator-signed owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-fixture-key-'));
  const key = path.join(dir, 'pub');
  const device = makeDevice();
  fs.writeFileSync(key, device.publicKey);
  const worker = spawn(process.execPath, ['scripts/conversation-tree-native-acceptance.mjs', key],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = once(worker, 'exit');
  try {
    let target: { host: string; deviceId: string; child: string; hidden: string } | undefined;
    const lines = createInterface({ input: worker.stdout });
    for await (const line of lines) {
      if (!line.startsWith('{"type":"conversation-tree-native-acceptance-ready"')) continue;
      target = JSON.parse(line);
      break;
    }
    if (!target) throw new Error('fixture failed to start');
    const { host, deviceId, child, hidden } = target;
    let stamp = Date.now();
    const read = async (route: string) => {
      const time = String(++stamp);
      const signature = device.sign(canonicalString(deviceId, host, 'GET', route, time, undefined));
      const response = await fetch(`http://${host}${route}`, { headers: {
        'X-Instar-Device': deviceId, 'X-Instar-Device-Time': time, 'X-Instar-Device-Sig': signature,
      } });
      expect(response.status).toBe(200);
      return response.json();
    };
    const list = await read('/mobile/conversations?scope=pool&limit=50');
    expect(list.conversations).toContainEqual(expect.objectContaining({ id: child, projectConversationKey: 'telegram:42',
      parentConversationKey: 'telegram:42', hierarchyState: 'child' }));
    expect(list.conversations).not.toContainEqual(expect.objectContaining({ id: hidden }));
    expect(list.pinned.id).toBe(41);
    const projects = await read('/mobile/work/projects');
    expect(projects.projects).toContainEqual(expect.objectContaining({ key: 'telegram:42' }));
    const tree = await read('/mobile/conversation-graph/tree');
    expect(tree.placementComplete).toBe(true);
    expect(tree.sections.projects).toEqual([expect.objectContaining({
      projectConversationKey: 'telegram:42', children: [expect.objectContaining({ title: 'Generated Project Chat' })],
    })]);
    expect(tree.sections.ungrouped).toEqual([expect.objectContaining({ title: 'Ordinary Chat' })]);
    expect(tree.sections.groups[0].children[0]).toMatchObject({ title: 'Nested Group' });
    expect(tree.items[0].children[0]).toMatchObject({ title: 'Nested Group' });
    expect((await fetch(`http://${host}/mobile/conversation-graph/tree`)).status).toBe(401);
  } finally {
    if (worker.exitCode === null) worker.kill('SIGTERM');
    await closed;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'conversation-tree-native-test:cleanup' });
  }
}, 30_000);
