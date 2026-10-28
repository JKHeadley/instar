import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The real host binary is restricted to dist/native. Test helpers live beside
// it for the duration of each test, so the production path and trust check run.
const helpers: string[] = [];
function helper(reply: string): MacDesktopHost {
  const filename = path.resolve('dist/native', `instar-desktop-capture-test-${process.pid}-${helpers.length}`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const script = `#!${process.execPath}\nimport fs from 'node:fs';const reply = ${JSON.stringify(reply)};let count=0;if(process.argv[2]==='release')process.exit(0);\n` +
    `process.stdin.on('data', () => { count++;\n` +
    `  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);\n` +
    `  if (reply === 'fragmented') { process.stdout.write(Buffer.from([0, 0])); setTimeout(() => process.stdout.write(Buffer.from([0, 4, 0xff, 0xd8])), 5); setTimeout(() => process.stdout.write(Buffer.from([0xff, 0xd9])), 10); }\n` +
    `  if (reply === 'zero') process.stdout.write(Buffer.alloc(4));\n` +
    `  if (reply === 'oversize') { const h = Buffer.alloc(4); h.writeUInt32BE(625001); process.stdout.write(h); }\n` +
    `  if (reply === 'trailing') { const h = Buffer.alloc(4); h.writeUInt32BE(4); process.stdout.write(Buffer.concat([h, jpeg, Buffer.from([1])])); }\n` +
    `  if (reply === 'midframe') { const h = Buffer.alloc(4); h.writeUInt32BE(4); process.stdout.write(Buffer.concat([h, jpeg.subarray(0, 2)]), () => process.exit(1)); }\n` +
    `  if (reply === 'silent') setInterval(() => {}, 1000);\n` +
    `  if (reply === 'cached') { if (count === 1) { const h=Buffer.alloc(4);h.writeUInt32BE(4);process.stdout.write(Buffer.concat([h,jpeg])); } else process.stdout.write(Buffer.alloc(4)); }\n` +
    `  if (reply === 'closes-stdin' && count === 1) { const h=Buffer.alloc(4);h.writeUInt32BE(4);process.stdout.write(Buffer.concat([h,jpeg]));setTimeout(()=>{process.stdin.on('error',()=>{});process.stdin.pause();process.stdin.removeAllListeners('data');fs.closeSync(0);},50);setInterval(()=>{},1000); }\n` +
    `  if (reply === 'input-closes-stdin' && count === 1) { process.stdout.write('{"ok":true}\\n');setTimeout(()=>{process.stdin.on('error',()=>{});process.stdin.pause();process.stdin.removeAllListeners('data');fs.closeSync(0);},50);setInterval(()=>{},1000); }\n` +
    `});\n`;
  fs.writeFileSync(filename, script, { mode: 0o700 });
  helpers.push(filename);
  return new MacDesktopHost(filename);
}

describe.skipIf(process.platform !== 'darwin')('MacDesktopHost persistent pipes', () => {
  afterEach(() => {
    for (const filename of helpers.splice(0)) SafeFsExecutor.safeUnlinkSync(filename, {
      operation: 'tests/unit/MacDesktopHostCapture.test.ts:cleanup',
    });
  });

  it('assembles fragmented header and JPEG payload', async () => {
    const host = helper('fragmented');
    expect(await host.capture()).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    host.stopIndicator();
  });

  it('reuses the last JPEG after a zero-length unchanged reply', async () => {
    const host = helper('cached');
    const first = await host.capture();
    expect(await host.capture()).toEqual(first);
    host.stopIndicator();
  });

  it('handles a helper that closes stdin without crashing the parent', async () => {
    const host = helper('closes-stdin');
    expect(await host.capture()).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await new Promise(resolve => setTimeout(resolve, 120));
    await expect(host.capture()).rejects.toThrow('mac-desktop-host-capture-unavailable');
    host.stopIndicator();
  });

  it('handles an input helper that closes stdin without crashing the parent', async () => {
    const host = helper('input-closes-stdin');
    const action = { kind: 'move' as const, x: 0.5, y: 0.5 };
    await host.input(action);
    await new Promise(resolve => setTimeout(resolve, 120));
    await expect(host.input(action)).rejects.toThrow('mac-desktop-host-input-unavailable');
    host.cancelInput();
  });

  it('accepts bounded button events and rejects malformed drag coordinates before native input', async () => {
    const host = helper('input-closes-stdin');
    await expect(host.input({ kind: 'buttonDown', x: -0.1, y: 0.5, button: 'left' }))
      .rejects.toThrow('mac-desktop-host-input-invalid');
    await host.input({ kind: 'buttonDown', x: 0.5, y: 0.5, button: 'left' });
    host.cancelInput();
  });

  it.each(['zero', 'oversize', 'trailing', 'midframe'])(
    'rejects %s replies and cancels the native child', async reply => {
      const host = helper(reply);
      await expect(host.capture()).rejects.toThrow('mac-desktop-host-capture-unavailable');
      host.stopIndicator();
    },
  );

  it('cancels an in-flight native read immediately when the grant stops', async () => {
    const host = helper('silent');
    const pending = host.capture();
    host.stopIndicator();
    await expect(pending).rejects.toThrow('mac-desktop-host-capture-cancelled');
  });

  it('bounds a silent native read and kills its child', async () => {
    const host = helper('silent');
    await expect(host.capture()).rejects.toThrow('mac-desktop-host-capture-timeout');
    host.stopIndicator();
  }, 7_000);
});
