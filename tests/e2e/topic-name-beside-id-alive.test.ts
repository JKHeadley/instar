/**
 * Feature-alive / wiring integrity — the topic name rides beside every topic id (operator rule
 * 2026-11-02). Asserts against the real boot source that the registry resolver is wired to the
 * live Telegram adapter (not left null), and that the session-facing sites render through the
 * shared formatter; then exercises the real adapter + formatter + injection tag end to end.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { setTopicNameResolver, topicRef } from '../../src/messaging/shared/topicRef.js';
import { buildInjectionTag } from '../../src/types/pipeline.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf-8');

afterEach(() => setTopicNameResolver(null));

describe('topic name beside id — wiring', () => {
  it('boot wires the resolver to the live adapter registry, before any session can be spawned', () => {
    const serverSrc = read('../../src/commands/server.ts');
    const decl = serverSrc.indexOf('let telegram: TelegramAdapter | undefined;');
    const wire = serverSrc.indexOf('setTopicNameResolver((id) => telegram?.getTopicName(id) ?? null);');
    expect(decl).toBeGreaterThan(0);
    expect(wire).toBeGreaterThan(decl);
    expect(wire).toBeLessThan(serverSrc.indexOf('new TelegramAdapter('));
  });

  it('the session-facing threadline sites render through the shared formatter', () => {
    expect(read('../../src/threadline/TopicLinkageHandler.ts')).toMatch(/const userTopic = topicRef\(userTopicId\);/);
    expect(read('../../src/threadline/ThreadlineRouter.ts')).toMatch(/const ref = topicRef\(r\.topicId\);/);
    expect(read('../../src/types/pipeline.ts')).toMatch(/topicNameFor\(topicId, topicName\)/);
  });

  it('is alive end to end: the adapter registry name reaches topicRef and the injection tag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-name-e2e-'));
    try {
      fs.writeFileSync(path.join(dir, 'topic-session-registry.json'), JSON.stringify({ topicToSession: { '11882': 'scout-hb' }, topicToName: { '11882': '🤝 echo' } }));
      const adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100123', pollIntervalMs: 100 }, dir);
      setTopicNameResolver((id) => adapter.getTopicName(id) ?? null);
      expect(topicRef(11882)).toBe('topic 11882 "🤝 echo"');
      expect(topicRef(55)).toBe('topic 55 (name unresolved)');
      expect(buildInjectionTag(11882, undefined, 'Justin')).toBe('[telegram:11882 "🤝 echo" from Justin]');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/topic-name-beside-id-alive.test.ts' });
    }
  });
});
