import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
// @ts-expect-error Console runs as native ESM in the browser.
import { conversationTreePreferences, hasAuthoritativeSections, renderOwnerTree, treeConversationRow, treePage } from '../../dashboard/console/conversation-tree.js';

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
    expect(host.firstElementChild?.querySelector('a')?.textContent).toBe('Chief of Staff');
    expect(host.firstElementChild?.querySelector('.conversation-tree-pinned-label')?.textContent).toBe('Pinned');
    expect(host.firstElementChild?.querySelector('.conversation-tree-chief-subtitle')?.textContent).toBe('Ask about any of your work here.');
    expect([...host.querySelectorAll(':scope > details > summary')].map(node => node.textContent)).toEqual(['Projects', 'Groups', 'Not in a group yet']);
    expect([...host.querySelectorAll('details')].every(section => section.open)).toBe(true);
    expect([...host.querySelectorAll('a')].map(node => node.textContent)).toEqual([
      'Chief of Staff', 'Newer worker', 'Project conversation', 'Group chat', 'See more in this group', 'Pending project header',
      'Ordinary conversation',
    ]);
  });

  it('draws the disclosure chevron without text that can decode as mojibake', () => {
    const css = readFileSync(new URL('../../dashboard/console/console.css', import.meta.url), 'utf8');
    const icon = css.match(/\.conversation-tree-disclosure > summary::before\s*\{([^}]+)\}/)?.[1];
    expect(icon).toMatch(/content:\s*'';/);
    expect(icon).toMatch(/border-block-start:\s*2px solid currentColor;/);
    expect(icon).toMatch(/border-inline-end:\s*2px solid currentColor;/);
  });

  it('renders the project conversation as a counted section without a saved group', () => {
    const project = chat(12, 'Project front door', {
      project: { title: 'Web Dashboard', conversationKey: 'telegram:12' },
      projectConversationKey: 'telegram:12', visibleChildCount: 1, descendantConversationCount: 2,
      children: [chat(14, 'Generated child', { children: [chat(15, 'Nested card conversation')] })],
    });
    const host = draw({ partial: false, placementComplete: true, projects: 'known',
      sections: { projects: [project], groups: [], ungrouped: [] } });
    const section = host.querySelector<HTMLDetailsElement>('.chat-project-row');
    expect(section?.open).toBe(true);
    expect(section?.querySelector('summary')?.textContent).toBe('Web Dashboard · 3 conversations');
    expect([...section!.querySelectorAll('a')].map(a => a.textContent)).toEqual(['Project front door', 'Generated child', 'Nested card conversation']);
  });

  it('shows complete single-chat projects and groups as rows and retains incomplete groups', () => {
    const project = chat(12, 'Project chat', { project: { title: 'One Project', conversationKey: 'telegram:12' },
      projectConversationKey: 'telegram:12', childrenComplete: true, descendantConversationCount: 0 });
    const raw = { partial: false, placementComplete: true, projects: 'known', sections: {
      projects: [project],
      groups: [group('single', 'Saved group', [group('nested', 'Nested', [chat(13, 'Only chat')])]),
        group('incomplete', 'Incomplete group', [chat(14, 'Known chat')], { childrenComplete: false })],
      ungrouped: [],
    } };
    const host = document.querySelector('main')!;
    host.replaceChildren(...renderOwnerTree([treePage(raw)], {
      preferences: conversationTreePreferences(),
      projectStatus: () => ({ tone: 'ok', label: 'Moving' }),
      conversationRow: (node: any, affiliation: any) => {
        const row = document.createElement('a');
        const title = document.createElement('span');
        title.className = 'chat-row-title';
        title.textContent = affiliation?.title || node.title;
        row.append(title);
        return treeConversationRow(row, affiliation?.title || node.title, null, affiliation);
      },
      groupDetails: () => document.createTextNode('See more'),
    }));
    const [projects, groups] = host.querySelectorAll('details.conversation-tree-section');
    expect(projects.querySelectorAll('details')).toHaveLength(0);
    expect(projects.querySelectorAll('a')).toHaveLength(1);
    expect(projects.querySelector('.chat-row-title')?.textContent).toBe('One Project');
    expect(projects.querySelector('.chat-group-icon-project svg')).toBeTruthy();
    expect(projects.querySelector('.chat-project-status')?.textContent).toBe('Moving');
    expect(groups.querySelectorAll('details')).toHaveLength(1);
    expect(groups.querySelector(':scope > details > summary')?.textContent).toBe('Incomplete group · 1 conversation');
    expect(groups.querySelector(':scope > a .chat-row-title')?.textContent).toBe('Saved group');
    expect(groups.querySelector(':scope > a .chat-group-icon svg')).toBeTruthy();
  });

  it('restores a collapsed group and does not put unresolved legacy rows in Ungrouped', () => {
    conversationTreePreferences().saveExpanded('section:Groups', false);
    const host = draw({ partial: true, projects: 'unknown', items: [group('two', 'Group two', []), chat(6, 'Unknown placement')] });
    expect(host.querySelector('details')?.open).toBe(false);
    expect(host.textContent).not.toContain('Unknown placement');
    expect(host.textContent).not.toContain('Not in a group yet');
    expect(host.textContent).toContain('Some conversation placements could not be checked.');
  });

  it('only activates when all explicit sections decode and placement is complete', () => {
    const sections = { projects: [], groups: [], ungrouped: [] };
    expect(hasAuthoritativeSections(treePage({ partial: true, sections, placementComplete: false }))).toBe(false);
    expect(hasAuthoritativeSections(treePage({ partial: false, sections }))).toBe(false);
    expect(hasAuthoritativeSections(treePage({ partial: false, items: [], placementComplete: true }))).toBe(false);
    expect(hasAuthoritativeSections(treePage({ partial: false, sections, placementComplete: true }))).toBe(true);
  });
  it('rejects malformed children and section payloads', () => {
    expect(treePage({ partial: false, items: [group('one', 'One', [null])] })).toBeNull();
    expect(treePage({ partial: false, sections: { projects: [], ungrouped: [] } })).toBeNull();
  });
});
