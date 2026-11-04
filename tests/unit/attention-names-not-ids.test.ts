import { describe, it, expect } from 'vitest';
import { nameIdsInText } from '../../src/messaging/shared/channelIdentity.js';

const names: Record<number, string> = { 127504: 'Instar dashboard makeover', 61449: 'Release notes' };
const machines: Record<string, string> = { m_03b30f5b32c6ef3eb0afd3ca7054e252: 'Mac Studio' };
const resolve = { topicName: (id: number) => names[id] ?? null, machineName: (id: string) => machines[id] ?? null };

describe('attention text names topics and machines, never their ids', () => {
  it('names a topic with a known name', () => {
    expect(nameIdsInText("Topic 127504's pin has waited 45h unfulfilled", resolve)).toBe('Topic "Instar dashboard makeover"\'s pin has waited 45h unfulfilled');
    expect(nameIdsInText('Autonomous re-registration refused for topic 127504', resolve)).toBe('Autonomous re-registration refused for topic "Instar dashboard makeover"');
  });
  it('names a telegram conversation key', () => {
    expect(nameIdsInText('Conversation telegram:61449 keeps re-duplicating', resolve)).toBe('Conversation "Release notes" keeps re-duplicating');
  });
  it('names a machine id, with or without the word machine', () => {
    expect(nameIdsInText('Machine m_03b30f5b32c6ef3eb0afd3ca7054e252 is flapping', resolve)).toBe('Mac Studio is flapping');
    expect(nameIdsInText('owned by m_03b30f5b32c6ef3eb0afd3ca7054e252.', resolve)).toBe('owned by Mac Studio.');
  });
  it('leaves an id with no verified name as written, never inventing one', () => {
    expect(nameIdsInText('Topic 999999 placement diverged', resolve)).toBe('Topic 999999 placement diverged');
    expect(nameIdsInText('Topic 42 x', { topicName: () => 'topic-42' })).toBe('Topic 42 x');
    expect(nameIdsInText('Machine m_aaaaaaaaaaaaaaaa down', { machineName: () => 'm_aaaaaaaaaaaaaaaa' })).toBe('Machine m_aaaaaaaaaaaaaaaa down');
  });
  it('does not touch numbers that are not topic ids, and survives a throwing resolver', () => {
    expect(nameIdsInText('waited 2892h, 3 topics', resolve)).toBe('waited 2892h, 3 topics');
    expect(nameIdsInText('Topic 127504 x', { topicName: () => { throw new Error('x'); } })).toBe('Topic 127504 x');
  });
});

describe('wiring', () => {
  it('both Telegram startup paths (polling and send-only) wire the machine-name resolver', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../src/commands/server.ts', import.meta.url), 'utf8');
    expect(src.match(/telegram\.setMachineNameResolver\(/g)?.length).toBe(2);
    const sendOnly = src.indexOf('telegram.startSendOnlyMaintenance();');
    expect(src.indexOf('telegram.setMachineNameResolver(', sendOnly) - sendOnly).toBeLessThan(200);
  });
});
