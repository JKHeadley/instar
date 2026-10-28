import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The real host binary is restricted to dist/native. Test helpers live beside
// it for the duration of each test, so the production path and trust check run.
const helpers: string[] = [];
let helperSerial = 0;
function helper(reply: string): MacDesktopHost {
  const filename = path.resolve('dist/native', `instar-desktop-capture-test-${process.pid}-${helperSerial++}`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const script = `#!${process.execPath}\nimport fs from 'node:fs';const reply = ${JSON.stringify(reply)};let count=0;if(process.argv[2]==='release'){let body='';process.stdin.on('data',chunk=>body+=chunk);process.stdin.on('end',()=>{if(reply==='release-fails')process.exit(69);const finish=()=>{if(reply.includes('record-release'))fs.writeFileSync(${JSON.stringify(filename + '.release')},body);if(reply!=='release-no-ack')process.stdout.write('{"ok":true}\\n');process.exit(0)};if(reply==='record-release-delayed')setTimeout(finish,150);else finish()});}else{\n` +
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
    `  if (reply === 'down-no-ack-record-release' && count === 1) setTimeout(()=>process.exit(1),10);\n` +
    `  if (reply === 'malformed-ack-late' && !fs.existsSync(${JSON.stringify(filename + '.fault')})) { fs.writeFileSync(${JSON.stringify(filename + '.fault')},'1'); setTimeout(()=>process.stdout.write('{"ok":false}\\n'),80); }\n` +
    `  else if (reply.startsWith('record-release') || reply === 'release-fails' || reply === 'release-no-ack' || reply === 'malformed-ack-late') process.stdout.write('{"ok":true}\\n');\n` +
    `});}\n`;
  fs.writeFileSync(filename, script, { mode: 0o700 });
  helpers.push(filename);
  return new MacDesktopHost(filename);
}

describe.skipIf(process.platform !== 'darwin')('MacDesktopHost persistent pipes', () => {
  afterEach(() => {
    for (const filename of helpers.splice(0)) {
      SafeFsExecutor.safeUnlinkSync(filename, { operation: 'tests/unit/MacDesktopHostCapture.test.ts:cleanup' });
      if (fs.existsSync(filename + '.release')) SafeFsExecutor.safeUnlinkSync(filename + '.release', {
        operation: 'tests/unit/MacDesktopHostCapture.test.ts:cleanup-release',
      });
      if (fs.existsSync(filename + '.fault')) SafeFsExecutor.safeUnlinkSync(filename + '.fault', {
        operation: 'tests/unit/MacDesktopHostCapture.test.ts:cleanup-fault',
      });
    }
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
    await host.cancelInput();
  });

  it('accepts bounded button events and rejects malformed drag coordinates before native input', async () => {
    const host = helper('input-closes-stdin');
    await expect(host.input({ kind: 'buttonDown', x: -0.1, y: 0.5, button: 'left' }))
      .rejects.toThrow('mac-desktop-host-input-invalid');
    await host.input({ kind: 'buttonDown', x: 0.5, y: 0.5, button: 'left' });
    await host.cancelInput();
  });

  it('accepts supported key transitions and rejects an unlisted native key', async () => {
    const host = helper('input-closes-stdin');
    await expect(host.input({ kind: 'keyDown', key: 'F13' } as never))
      .rejects.toThrow('mac-desktop-host-input-invalid');
    await host.input({ kind: 'keyDown', key: 'Meta' });
    await host.cancelInput();
  });

  it('releases only remotely held controls and leaves other local keys untouched', async () => {
    const host = helper('record-release');
    const filename = helpers.at(-1)! + '.release';
    await host.input({ kind: 'keyDown', key: 'Meta' });
    await host.input({ kind: 'buttonDown', x: 0.5, y: 0.5, button: 'left' });
    await host.cancelInput();
    for (let i = 0; i < 50 && !fs.existsSync(filename); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual({ buttons: ['left'], keys: ['Meta'] });
  });

  it('does not launch a release helper when this grant held no controls', async () => {
    const host = helper('record-release');
    const filename = helpers.at(-1)! + '.release';
    await host.input({ kind: 'move', x: 0.5, y: 0.5 });
    await host.cancelInput();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fs.existsSync(filename)).toBe(false);
  });

  it('rejects duplicate and unmatched key or button transitions without changing held state', async () => {
    const host = helper('record-release');
    await expect(host.input({ kind: 'keyUp', key: 'Meta' }))
      .rejects.toThrow('mac-desktop-host-input-transition-invalid');
    await host.input({ kind: 'keyDown', key: 'Meta' });
    await expect(host.input({ kind: 'keyDown', key: 'Meta' }))
      .rejects.toThrow('mac-desktop-host-input-transition-invalid');
    await host.input({ kind: 'keyUp', key: 'Meta' });
    await expect(host.input({ kind: 'buttonUp', x: 0.5, y: 0.5, button: 'left' }))
      .rejects.toThrow('mac-desktop-host-input-transition-invalid');
    await host.input({ kind: 'buttonDown', x: 0.5, y: 0.5, button: 'left' });
    await expect(host.input({ kind: 'buttonDown', x: 0.5, y: 0.5, button: 'right' }))
      .rejects.toThrow('mac-desktop-host-input-transition-invalid');
    await host.input({ kind: 'buttonUp', x: 0.5, y: 0.5, button: 'left' });
    await host.cancelInput();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fs.existsSync(helpers.at(-1)! + '.release')).toBe(false);
  });

  it('releases an uncertain key down when the native ACK is lost', async () => {
    const host = helper('down-no-ack-record-release');
    const filename = helpers.at(-1)! + '.release';
    await expect(host.input({ kind: 'keyDown', key: 'Meta' })).rejects.toThrow('mac-desktop-host-input-unavailable');
    await expect(host.input({ kind: 'move', x: 0.5, y: 0.5 }))
      .rejects.toThrow('mac-desktop-host-input-uncertain');
    await host.cancelInput();
    expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual({ buttons: [], keys: ['Meta'] });
  });

  it('waits for the old helper to exit and its release to finish before new input', async () => {
    const host = helper('record-release-delayed');
    await host.input({ kind: 'keyDown', key: 'Meta' });
    const oldRelease = host.cancelInput();
    let newInputDone = false;
    const newInput = host.input({ kind: 'keyDown', key: 'Meta' }).then(() => { newInputDone = true; });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(newInputDone).toBe(false);
    await oldRelease;
    await newInput;
    expect(newInputDone).toBe(true);
    await host.cancelInput();
  });

  it('keeps a failed helper in the exit barrier before release or replacement input', async () => {
    const host = helper('malformed-ack-late');
    const pending = host.input({ kind: 'keyDown', key: 'Meta' });
    type TestChild = { kill(signal?: NodeJS.Signals): boolean };
    let child: TestChild | null = null;
    for (let attempt = 0; attempt < 20 && !child; attempt++) {
      child = (host as unknown as { inputStream: TestChild | null }).inputStream;
      if (!child) await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(child).not.toBeNull();
    const originalKill = child!.kill.bind(child);
    child!.kill = signal => { setTimeout(() => originalKill(signal), 150); return true; };
    await expect(pending).rejects.toThrow('mac-desktop-host-input-unavailable');
    await expect(host.input({ kind: 'move', x: 0.5, y: 0.5 }))
      .rejects.toThrow('mac-desktop-host-input-uncertain');
    const release = host.cancelInput();
    let replacementDone = false;
    const replacement = host.input({ kind: 'keyDown', key: 'Meta' }).then(() => { replacementDone = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(replacementDone).toBe(false);
    await release;
    await replacement;
    await host.cancelInput();
  });

  it('fails new input closed when native release cannot post because OS preflight fails', async () => {
    const host = helper('release-fails');
    await host.input({ kind: 'keyDown', key: 'Meta' });
    await expect(host.cancelInput()).rejects.toThrow('mac-desktop-host-unavailable');
    await expect(host.input({ kind: 'keyDown', key: 'Meta' }))
      .rejects.toThrow('mac-desktop-host-release-unconfirmed');
    await expect(host.cancelInput()).rejects.toThrow('mac-desktop-host-unavailable');
  });

  it('fails new input closed when the release helper omits its success reply', async () => {
    const host = helper('release-no-ack');
    await host.input({ kind: 'keyDown', key: 'Meta' });
    await expect(host.cancelInput()).rejects.toThrow('mac-desktop-host-release-invalid');
    await expect(host.input({ kind: 'keyDown', key: 'Meta' }))
      .rejects.toThrow('mac-desktop-host-release-unconfirmed');
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
