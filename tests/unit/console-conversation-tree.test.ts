import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
// @ts-expect-error Console runs as native ESM in the browser.
import { conversationTreePreferences, renderOwnerTree, treePage } from '../../dashboard/console/conversation-tree.js';

const chat = (id: number, title: string, more = {}) => ({
  ref: { kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId: id },
  kind: 'conversation',
  role: 'front-door',
  title,
  sourceFreshness: `2026-11-${String(id).padStart(2, '0')}T00:00:00Z`,
  visibleChildCount: 0,
  ...more,
});
const group = (id: string, title: string, children: unknown[], more = {}) => ({
  ref: { kind: 'effort', id }, kind: 'effort', role: 'effort', title, children, childrenComplete: true,
  visibleChildCount: children.length, ...more,
});

describe('shared Conversations tree', () => {
  let browser: JSDOM;
  beforeEach(() => {
    browser = new JSDOM('<main></main>', { url: 'http://localhost' });
    vi.stubGlobal('document', browser.window.document);
    vi.stubGlobal('localStorage', browser.window.localStorage);
  });
  afterEach(() => { browser.window.close(); vi.unstubAllGlobals(); });

  function draw(raw: unknown) {
    const page = treePage(raw);
    expect(page).toBeTruthy();
    const host = document.querySelector('main')!;
    host.replaceChildren(...renderOwnerTree([page], {
      preferences: conversationTreePreferences(),
      conversationRow: (node: { title: string }) => Object.assign(document.createElement('a'), { textContent: node.title }),
      groupDetails: () => Object.assign(document.createElement('a'), { textContent: 'See more in this group' }),
    }));
    return host;
  }

  it('renders the Chief first, keeps nested sections expanded, and places each chat once', () => {
    const projectChat = chat(4, 'Project conversation', { projectConversationKey: 'telegram:4' });
    const page = { partial: false, placementComplete: true, projects: 'known', root: chat(1, 'Chief of Staff'),
      sections: {
        projects: [group('apps', 'Instar Apps', [group('web', 'Web Dashboard', [projectChat, chat(8, 'Newer worker')], {
          project: { title: 'Web Dashboard', conversationKey: 'telegram:4' },
        })])],
        groups: [group('general', 'General', [group('nested', 'Nested group', [chat(3, 'Group chat')], { childrenComplete: false })])],
        ungrouped: [chat(2, 'Ordinary conversation'), projectChat, chat(7, 'Pending project header', { projectConversationKey: 'telegram:9' })],
      } };
    const host = draw(page);
    expect(host.firstElementChild?.textContent).toBe('Chief of Staff');
    expect([...host.querySelectorAll(':scope > details > summary')].map(node => node.textContent)).toEqual(['Projects', 'Groups', 'Ungrouped']);
    expect([...host.querySelectorAll('details')].every(section => section.open)).toBe(true);
    expect([...host.querySelectorAll('a')].map(node => node.textContent)).toEqual([
      'Chief of Staff', 'Newer worker', 'Project conversation', 'Group chat', 'See more in this group', 'Ordinary conversation',
    ]);
  });

  it('restores a collapsed group and does not put unresolved legacy rows in Ungrouped', () => {
    conversationTreePreferences().saveExpanded('section:Groups', false);
    const host = draw({ partial: true, projects: 'unknown', items: [group('two', 'Group two', []), chat(6, 'Unknown placement')] });
    expect(host.querySelector('details')?.open).toBe(false);
    expect(host.textContent).not.toContain('Unknown placement');
    expect(host.textContent).not.toContain('Ungrouped');
    expect(host.textContent).toContain('Some conversation placements could not be checked.');
  });

  it('rejects malformed children and section payloads', () => {
    expect(treePage({ partial: false, items: [group('one', 'One', [null])] })).toBeNull();
    expect(treePage({ partial: false, sections: { projects: [], ungrouped: [] } })).toBeNull();
  });
});
