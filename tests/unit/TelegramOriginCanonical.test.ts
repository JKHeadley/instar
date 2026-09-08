import { describe, expect, it } from 'vitest';
import { canonicalOrigin, originDigest, parseOriginJson, wireDigest } from '../../src/messaging/telegram-origin/CanonicalOrigin.js';
import { originFooter, resolveOriginDisplay } from '../../src/messaging/telegram-origin/OriginPresentation.js';
import type { TelegramOriginProducer } from '../../src/messaging/telegram-origin/types.js';

describe('origin canonical bytes', () => {
  it('keeps Unicode, array order and decimal ID strings while sorting UTF-16 keys', () => {
    const v = { z: 'e\u0301/😀', a: ['9223372036854775807', { z: 2, a: 1 }] };
    const bytes = '{"a":["9223372036854775807",{"a":1,"z":2}],"z":"é/😀"}';
    expect(canonicalOrigin(v)).toBe(bytes);
    expect(originDigest(v)).toBe(wireDigest(bytes));
    expect(originDigest(v)).not.toBe(originDigest({ ...v, z: 'é/😀' }));
  });
  it('refuses duplicate escaped names before parsing at all nesting depths', () => {
    for (const raw of ['{"a":1,"a":2}', '{"x":{"a":1,"\\u0061":2}}', '[{"a":1,"a":2}]']) {
      expect(() => parseOriginJson(raw)).toThrow('duplicate');
    }
    expect(parseOriginJson('{"a":{"a":1},"b":{"a":2}}')).toEqual({ a: { a: 1 }, b: { a: 2 } });
  });
  it('rejects non-JSON, unsafe numbers, sparse arrays and surrogate fragments', () => {
    for (const v of [NaN, Infinity, 9007199254740992, undefined, '\ud800', '\udc00', new Date(), { x: undefined }, Array(1), 0.5]) {
      expect(() => canonicalOrigin(v)).toThrow();
    }
    expect(() => canonicalOrigin({ get secret() { throw new Error('getter executed'); } })).toThrow('accessor');
    expect(canonicalOrigin(-0)).toBe('0');
  });
});
const producer: TelegramOriginProducer = {
  agentId: 'echo', agentName: 'Echo', originMachineId: 'machine1', originMachineName: 'Mac Studio',
  sessionId: 'session1', sessionIncarnation: 'inc1', turnId: 'turn1', producerKind: 'session', producerId: 'session1',
  harnessId: 'codex-cli', harnessName: 'Codex',
  machine: { value: 'Mac Studio', status: 'observed', sourceEventRef: 'machine:1', observedAt: 1, reason: null },
  harness: { value: 'codex-cli', status: 'observed', sourceEventRef: 'runtime:1', observedAt: 1, reason: null },
  model: { value: 'gpt-6-astra', status: 'observed', sourceEventRef: 'turn:1', observedAt: 1, reason: null },
};
describe('origin optional display', () => {
  it('shows all three fields by default and preserves all explicit false overrides', () => {
    expect(originFooter(producer, resolveOriginDisplay())).toBe('Echo · Mac Studio · Codex · gpt-6-astra');
    expect(originFooter(producer, resolveOriginDisplay({}, { enabled: false }))).toBe('');
    expect(originFooter(producer, resolveOriginDisplay({}, { machine: false, harness: false, model: false }))).toBe('');
    expect(originFooter(producer, resolveOriginDisplay({ model: false }, { machine: false }))).toBe('Echo · Codex');
    expect(producer.model.value).toBe('gpt-6-astra');
  });
  it('labels configured and unknown evidence rather than presenting the desired model as observed', () => {
    expect(originFooter({ ...producer, model: { ...producer.model, status: 'configured' } }, resolveOriginDisplay())).toContain('gpt-6-astra (configured)');
    expect(originFooter({ ...producer, model: { ...producer.model, value: null, status: 'unknown' } }, resolveOriginDisplay())).toContain('unknown');
  });
});
