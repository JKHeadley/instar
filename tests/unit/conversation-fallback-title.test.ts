/**
 * A conversation with no stored name shows its bound project's title, never "Name not available
 * yet" (Justin, 2026-11-20, after the Studio rebuild lost ~60 topic names on every machine).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { projectTitlesByTopic, topicDisplayName } from '../../src/server/conversationFallbackTitle.js';
import { topicNameMap } from '../../dashboard/console/topic-names.js';

const ROOT = path.join(__dirname, '../..');

describe('projectTitlesByTopic', () => {
  it('maps bound Telegram projects to their titles; skips app/slack keys, placeholders and id-like titles', () => {
    const m = projectTitlesByTopic([
      { conversationKey: 'telegram:127504', title: 'Finish the dashboard makeover' },
      { conversationKey: 'telegram:128732', title: '  A readable feature maturation   dashboard… ' },
      { conversationKey: 'app:0b0c0d0e', title: 'An app conversation' },
      { conversationKey: 'telegram:9210', title: 'Untitled project' },
      { conversationKey: 'telegram:1234', title: 'topic 1234' },
      { conversationKey: 'telegram:555', title: '' },
    ]);
    expect([...m.entries()]).toEqual([[127504, 'Finish the dashboard makeover'], [128732, 'A readable feature maturation dashboard…']]);
    expect(projectTitlesByTopic(null).size).toBe(0);
  });
});

describe('topicDisplayName', () => {
  const titles = new Map([[127504, 'Finish the dashboard makeover']]);
  it('a stored real name always wins', () => {
    expect(topicDisplayName(127504, 'Instar dashboard makeover', titles)).toBe('Instar dashboard makeover');
  });
  it('a missing or placeholder name falls back to the project title', () => {
    expect(topicDisplayName(127504, null, titles)).toBe('Finish the dashboard makeover');
    expect(topicDisplayName(127504, 'topic-127504', titles)).toBe('Finish the dashboard makeover');
  });
  it('no name and no project: null (the caller decides the words)', () => {
    expect(topicDisplayName(42, null, titles)).toBeNull();
  });
});

describe('console topic names read the server fallbacks', () => {
  it('a fallback fills only a topic with no verified name', () => {
    const names = topicNameMap({ ok: true, data: {
      topics: [{ topicId: 2, topicName: 'Lifeline' }],
      fallbacks: [{ topicId: 127504, title: 'Finish the dashboard makeover', source: 'project' }, { topicId: 2, title: 'Should not win', source: 'project' }, { topicId: 9, title: 'topic 9' }],
    } });
    expect(names).toEqual({ 2: 'Lifeline', 127504: 'Finish the dashboard makeover' });
  });
});

describe('wiring: every reader of topic names gets the fallback', () => {
  const agentServer = fs.readFileSync(path.join(ROOT, 'src/server/AgentServer.ts'), 'utf8');
  const routes = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf8');
  it('the app conversation list and conversation search use topicDisplayName with the Chief of Staff titles', () => {
    expect(agentServer).toContain('projectTitlesByTopic(options.chiefOfStaffLoop?.projectsSummary() ?? [])');
    expect(agentServer).toContain('topicName: topicDisplayName(m.topicId, m.topicName, projectTitles), lastActivity');
    expect(agentServer).toContain('topicName: topicDisplayName(m.topicId, m.topicName, projectTitles) }));');
  });
  it('the pool topic list sends fallbacks for unresolved topics, apart from verified names', () => {
    expect(routes).toContain('projectTitlesByTopic(ctx.chiefOfStaffLoop?.projectsSummary() ?? [])');
    expect(routes).toContain('fallbacks: filterTopicsForTeam(ctx.mobilePairingService, req, fallbacks, (t) => t.topicId),');
  });
});
