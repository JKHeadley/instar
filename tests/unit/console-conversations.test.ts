import { describe, it, expect } from 'vitest';
import { listModel, nodeModel, sourceLink, pageQuery, syncWords, historyPath, historyModel, encodeNodeRef } from '../../dashboard/console/conversations-model.js';

const item = (n: number) => ({ ref: { kind: 'effort', id: `effort-${n}` }, title: `Effort ${n}`, kind: 'effort', role: 'front-door', visibleChildCount: 1, primaryPath: [] });
const page = (items: unknown[]) => ({ items, revision: 'r1', asOf: '2026-11-05T09:00:00Z', partial: false, nextCursor: null });

describe('Conversations view contract', () => {
  it('keeps Overview quiet while every authorized worker remains in All', () => {
    const input = page(Array.from({ length: 8 }, (_, n) => item(n)));
    expect(listModel(input, 'overview').items).toHaveLength(5);
    expect(listModel(input, 'overview').hasMore).toBe(true);
    expect(listModel(input, 'all').items).toHaveLength(8);
  });
  it('reads effort-only front-door metadata while preserving legacy expanded fields and untitled headers',()=>{
    const frontDoor={kind:'conversation',platform:'telegram',chatId:'-100123',topicId:42};
    const model=listModel(page([{...item(1),title:'',metadata:{frontDoor}}]),'all').items[0];
    expect(model.title).toBe('Untitled');expect(model.visibleChildCount).toBe(1);expect(model.frontDoor).toEqual(frontDoor);
    expect(listModel(page([{...item(1),frontDoor}]),'all').items[0].frontDoor).toBeNull();
    expect(listModel(page([{...item(1),metadata:{frontDoor:item(2).ref}}]),'all').items[0].frontDoor).toBeNull();
    expect(listModel(page([{ref:frontDoor,title:'Worker',metadata:{frontDoor}}]),'all').items[0].frontDoor).toBeNull();
  });
  it('never turns unavailable or malformed data into a complete empty view', () => {
    expect(listModel({}, 'overview').ok).toBe(false);
    expect(listModel({ ...page([]), partial: undefined }, 'overview').ok).toBe(false);
    expect(listModel(page([]), 'overview').ok).toBe(true);
  });
  it('keeps refs opaque, uses only visible child counts, and ignores unproven decision fields', () => {
    const model = listModel(page([{ ...item(1), childCount: 999, decisionCount: 7, title: '<img onerror=alert(1)>' }]), 'all');
    expect(model.items[0].title).toBe('<img onerror=alert(1)>');
    expect(model.items[0].visibleChildCount).toBe(1);
    expect(model.items[0]).not.toHaveProperty('decisionCount');
  });
  it('names replica lag separately from unavailable history', () => {
    expect(syncWords({ partial: true, partialReasons: ['peer-not-replicated'] })).toContain('Syncing');
    expect(syncWords({ partial: true, partialReasons: ['history-unavailable'] })).toContain('history');
    expect(syncWords({ partial: true, partialReasons: ['event-gap'] })).toContain('catching up');
    expect(syncWords({ partial: false })).toBe('');
    expect(syncWords({ partial: true, partialReasons: [{ reason: 'replica-lag' }] })).toContain('Syncing');
    expect(syncWords({ partial: true, partialReasons: [{ reason: 'evidence-missing' }] })).toContain('history');
  });
  it('opens exact original source routes and never treats a Slack local id as portable', () => {
    expect(historyPath({ platform: 'telegram', conversationId: 42 })).toBe('/telegram/topics/42/messages?limit=50&scope=pool');
    expect(historyPath({ platform: 'slack', conversationId: -9, machine: 'm1' })).toBe('/mobile/chat/slack/-9/messages?limit=50&machine=m1');
    expect(historyPath({ platform: 'slack', conversationId: -9 })).toBeNull();
    expect(historyPath({ platform: 'telegram', conversationId: -9 })).toBeNull();
    expect(historyPath({ platform: 'app', conversationId: 'a/b' })).toContain('/a%2Fb/messages');
    expect(historyPath({ platform: 'telegram', conversationId: 42 }, '2026-11-05T09:00:00Z|71')).toContain('beforeMessageId=71');
  });
  it('keeps observed Telegram coverage honest and orders original messages with their timestamps', () => {
    const m = historyModel({ messages: [
      { messageId: 2, timestamp: '2026-11-05T09:00:00Z', text: '<script>text only</script>', fromUser: false },
      { messageId: 1, timestamp: '2026-11-05T08:00:00-01:00', text: 'owner source', fromUser: true },
    ], pool: { failed: [{ machineId: 'missing' }] } }, { platform: 'telegram' });
    expect(m.observedOnly).toBe(true);
    expect(m.partial).toBe(true);
    expect(m.messages[0].at).toContain('-01:00');
    expect(m.messages[1].text).toBe('<script>text only</script>');
  });
  it('builds query arguments without interpreting a source ref or losing search text', () => {
    expect(pageQuery('all', 'build & ship', 'opaque+/=')).toBe('view=all&q=build+%26+ship&cursor=opaque%2B%2F%3D');
  });
  it('encodes typed refs only at the URL boundary and preserves chat scope', () => {
    const a = { kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId: 42 };
    expect(encodeNodeRef(a)).toBe(Buffer.from(JSON.stringify({ chatId: '-1001', kind: 'conversation', platform: 'telegram', topicId: 42 })).toString('base64url'));
    expect(encodeNodeRef({ ...a, chatId: '-1002' })).not.toBe(encodeNodeRef(a));
    expect(encodeNodeRef('telegram:42')).toBeNull();
    expect(encodeNodeRef({ ...a, unknown: true })).toBeNull();
  });
  it('allows original platform links but rejects executable, credential-bearing and unexpected links', () => {
    expect(sourceLink('https://t.me/c/123/456')).toBe('https://t.me/c/123/456');
    expect(sourceLink('https://app.slack.com/client/T1/C1')).toBeTruthy();
    for (const url of ['javascript:alert(1)', 'https://evil.example/', 'https://t.me@evil.example/', 'https://u:p@t.me/c/1', '//evil.example', 'data:text/html,hello']) {
      expect(sourceLink(url)).toBe(null);
    }
  });
  it('normalizes deep node children and missing/hidden nodes without manufacturing a path', () => {
    expect(nodeModel({ node: item(1), path: [], children: { items: [item(2)], nextCursor: null }, links: [], provenance: [], partial: false }).children).toHaveLength(1);
    expect(nodeModel({}).ok).toBe(false);
  });
});
