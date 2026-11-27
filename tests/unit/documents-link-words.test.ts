/**
 * The "Link this computer to your phone" page (Justin 2026-11-18: out of date; make it more explicit and easier to
 * follow). Its words live in doc-page-model.js: what linking lets the computer do, then numbered steps naming the
 * iPhone app's own buttons (build 112: People → "Link a computer", "Link for 30 days", Face ID), and the fallback
 * for an app without the button. The 30 days must match the server's own cap.
 */
// @ts-nocheck — the page modules are browser-native ESM (.js), no types.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { LINK_WORDS, linkStepText } from '../../dashboard/docs/doc-page-model.js';
import { LINK_MAX_DAYS } from '../../src/server/documentLinkRoutes.js';

const PAGE = fs.readFileSync(path.resolve(__dirname, '../../dashboard/docs/doc-page.js'), 'utf8');

describe('the link page words', () => {
  it('says up front what linking lets this computer do, and its limits', () => {
    expect(LINK_WORDS.title).toBe('Link this computer to your phone');
    expect(LINK_WORDS.lead).toMatch(/^Linking lets this computer open your documents, read them and comment, for 30 days/);
    expect(LINK_WORDS.limits).toContain('only sees documents you can see');
    expect(LINK_WORDS.limits).toContain('People → Linked computers');
  });
  it('five numbered steps with the app\'s exact button words, in order', () => {
    expect(LINK_WORDS.steps.map(linkStepText)).toEqual([
      'Open Instar on your iPhone.',
      'Tap Agents, select this agent, then scroll down to “People”.',
      'Tap “Link a computer”.',
      'Scan the code on this screen.',
      'Check that the code on your phone matches the one here, tap “Link for 30 days”, then confirm with Face ID.',
    ]);
    expect(LINK_WORDS.steps.filter((s) => s.button).map((s) => s.button)).toEqual(['People', 'Link a computer', 'Link for 30 days']);
  });
  it('keeps the way in for a phone without the People button', () => {
    expect(LINK_WORDS.fallback).toContain('open any document in the app and tap “Open on a computer”');
  });
  it('the 30 days is the server\'s own cap', () => {
    expect(LINK_MAX_DAYS).toBe(30);
    for (const t of [LINK_WORDS.lead, linkStepText(LINK_WORDS.steps[4])]) expect(t).toContain(`${LINK_MAX_DAYS} days`);
  });
  it('linkStepText is safe on odd input', () => {
    expect(linkStepText(null)).toBe('');
    expect(linkStepText({})).toBe('');
  });
  it('the page draws these words, not the old one-sentence instruction', () => {
    expect(PAGE).toContain('M.LINK_WORDS');
    expect(PAGE).toContain("el('ol', { cls: 'link-steps' }");
    expect(PAGE).not.toContain('go to People → Link a computer, scan this code');
  });
});
