/** The console's Documents list (instar-document-viewer §3.6): words only, never document content. */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain browser module
import { conversationWords, rowWords } from '../../dashboard/console/documents.js';
// @ts-expect-error — plain browser module
import { GROUPS, CONSOLE_ONLY_TABS, NATIVE_PAGES } from '../../dashboard/console/nav-model.js';

describe('console documents list', () => {
  it('names a row by title, version, open comments and its conversation', () => {
    expect(rowWords({ title: 'Plan', version: 3, openComments: 2, primary: 'telegram:7' })).toEqual({ title: 'Plan', sub: 'version 3, 2 open comments · Telegram topic 7' });
    expect(rowWords({ title: null, version: 1, openComments: 1, primary: 'app:x' }).title).toContain('only its conversation can read it');
    expect(conversationWords('app:abc')).toBe('App conversation');
  });
  it('is a Work tile that hides itself when documents are off', () => {
    const tab = GROUPS.find((g: { id: string }) => g.id === 'work').tabs.find((t: { id: string }) => t.id === 'documents');
    expect(tab.probe).toBe('/docs/health');
    expect(CONSOLE_ONLY_TABS).toContain('documents');
    expect(NATIVE_PAGES.documents).toBe('#/work/documents');
  });
});
