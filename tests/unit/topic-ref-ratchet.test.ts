/**
 * Ratchet — a topic id is never rendered bare in server-authored text (operator rule 2026-11-02:
 * "An Instar agent should ALWAYS have access to the topic name if they have access to the topic
 * ID. The name and ID should be inseparable.").
 *
 * Counts template-literal renders of a bare `topic ${…}` / `Topic ${…}` / `Telegram topic ${…}`
 * in `src/` on lines that are not log calls. Each file may hold at most its baseline count; a
 * NEW site fails here. Render the id through `topicRef(id)` / `TopicRef(id)` /
 * `telegramTopicRef(id)` from `src/messaging/shared/topicRef.ts` instead, which carries the
 * verified name or says "(name unresolved)".
 *
 * The baseline holds only the existing prompt with an adjacent name and one lifeline log.
 * New bare renders fail this test.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../../src');

const BARE = /(?:Telegram topic|[Tt]opic) #?\$\{/g;
const LOG_LINE = /console\.|log\(|\.log\?\.\(|warn\(|\.debug\(|logger\.|logger\?\.\(|\[[A-Za-z0-9 _./:-]+\] /;

export const BASELINE: Record<string, number> = {
  'src/core/InputGuard.ts': 1,
  'src/lifeline/TelegramLifeline.ts': 1,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export function countBareTopicIds(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (LOG_LINE.test(line)) continue;
    const m = line.match(BARE);
    if (m) n += m.length;
  }
  return n;
}

describe('topic id never rendered without its name (ratchet)', () => {
  it('no file renders more bare topic ids than its baseline', () => {
    const over: string[] = [];
    for (const f of walk(SRC)) {
      const rel = path.relative(path.resolve(SRC, '..'), f).split(path.sep).join('/');
      if (rel === 'src/messaging/shared/topicRef.ts') continue;
      const n = countBareTopicIds(fs.readFileSync(f, 'utf-8'));
      const allowed = BASELINE[rel] ?? 0;
      if (n > allowed) over.push(`${rel}: ${n} bare topic id render(s), baseline ${allowed} — use topicRef(id) from src/messaging/shared/topicRef.ts`);
    }
    expect(over).toEqual([]);
  });

  it('the detector catches a bare render and ignores a log line and a topicRef render', () => {
    expect(countBareTopicIds('const t = `posted to topic ${id}`;')).toBe(1);
    expect(countBareTopicIds('const t = `Telegram topic ${id} and Topic ${x}`;')).toBe(2);
    expect(countBareTopicIds('console.log(`posted to topic ${id}`);')).toBe(0);
    expect(countBareTopicIds('const t = `posted to ${topicRef(id)}`;')).toBe(0);
  });
});
