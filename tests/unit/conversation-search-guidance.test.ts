import { describe, expect, it } from 'vitest';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { migrateConversationSearchGuidance } from '../../src/scaffold/conversationSearchGuidance.js';

describe('conversation search guidance', () => {
  it('puts conversation history in Registry First on fresh installs', () => {
    const text = generateClaudeMd('test', 'Echo', 4312, true);
    expect(text).toContain('| Where did we discuss this before? | `GET /mobile/conversations/search?q=...&scope=pool`');
    expect(text).toContain('http://localhost:4312/mobile/conversations/search?scope=pool&limit=10');
    expect(text).toContain('| My past learnings about X? | `GET /semantic/search?q=X`');
    expect(text).not.toContain('/memory/search');
    expect(text).not.toContain('Full-text search over all memory files');
  });

  it('replaces shipped legacy pointers once, preserving custom notes', () => {
    const original = [
      '| Something I wrote before | `GET /memory/search?q=...` |',
      '| **Memory Search** | Full-text search over all memory files (FTS5) |',
      '| My past learnings about X? | `GET /memory/search?q=X` |',
      '5. **Need to find something I wrote before?** Use memory search (`GET /memory/search?q=...`).',
      `- User asks **"didn't we talk about X?"** or **"where did I put that?"** → Use memory search (\`GET /memory/search?q=...\`). The full-text index covers everything I've written.`,
    ].join('\n');
    const custom = 'Custom note: /memory/search points at my indexed notes.';
    const migrated = migrateConversationSearchGuidance(`${original}\n${custom}`);
    expect(migrated).toContain('/mobile/conversations/search?q=...&scope=pool');
    expect(migrated).toContain('/semantic/search?q=X');
    expect(migrated).not.toContain('covers everything');
    expect(migrated).not.toContain('Full-text search over all memory files');
    expect(migrated.split('/memory/search')).toHaveLength(2);
    expect(migrated).toContain(custom);
    expect(migrateConversationSearchGuidance(migrated)).toBe(migrated);
  });
  it('updates the stock legacy capability block using its installed port', () => {
    const old = [
      "**Memory Search** — Full-text search over all indexed memory files using SQLite FTS5. Find anything you've ever written to MEMORY.md, handoff notes, or state files.",
      "- Search: `curl -H \"Authorization: Bearer $AUTH\" \"http://localhost:4312/memory/search?q=QUERY&limit=10\"`",
      "- Stats: `curl -H \"Authorization: Bearer $AUTH\" http://localhost:4312/memory/stats`",
      "- Reindex: `curl -X POST -H \"Authorization: Bearer $AUTH\" http://localhost:4312/memory/reindex`",
      "- Sync (incremental): `curl -X POST -H \"Authorization: Bearer $AUTH\" http://localhost:4312/memory/sync`",
      "- **Auto-sync**: Search automatically syncs before querying, so results are always current.",
      "- **When to use**: When looking for something you know you wrote but can't remember where. When a user asks \"didn't we discuss X?\" When building context for a task from past learnings.",
    ].join('\n');
    const migrated = migrateConversationSearchGuidance(old);
    expect(migrated).toContain('http://localhost:4312/mobile/conversations/search?scope=pool&limit=10');
    expect(migrated).toContain('failedMachines');
    expect(migrateConversationSearchGuidance(migrated)).toBe(migrated);
  });

});
