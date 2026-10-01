/**
 * Unit — display polish for the dashboard door + model controls (follow-up to
 * docs/specs/dashboard-door-model-controls.md, found in a phone-width live
 * walkthrough 2026-10-01): friendly model names, one row per model, badges
 * that never wrap mid-word, and a plain-English refusal for an unowned topic.
 *
 * The helpers live inline in dashboard/index.html, so they are extracted from
 * the page source and evaluated here — the test runs the shipped code.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf-8');

function extract(name: string): string {
  const start = HTML.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`dashboard helper not found: ${name}`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(`unterminated dashboard helper: ${name}`);
}

const helpers = new Function(
  `${extract('friendlyModelName')}\n${extract('modelFamilyClass')}\n${extract('visibleModels')}\n` +
  'return { friendlyModelName, modelFamilyClass, visibleModels };',
)() as {
  friendlyModelName: (id: string | null | undefined) => string;
  modelFamilyClass: (id: string | null | undefined) => string;
  visibleModels: (models: string[], selected: string | null | undefined) => string[];
};

describe('friendlyModelName', () => {
  it('renders Claude ids as family + version', () => {
    expect(helpers.friendlyModelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(helpers.friendlyModelName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(helpers.friendlyModelName('claude-opus-5')).toBe('Opus 5');
    expect(helpers.friendlyModelName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
  });

  it('drops a date suffix rather than reading it as a version', () => {
    expect(helpers.friendlyModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('renders Codex ids with their tier word', () => {
    expect(helpers.friendlyModelName('gpt-5.6-sol')).toBe('GPT-5.6 Sol');
    expect(helpers.friendlyModelName('gpt-6-luna')).toBe('GPT-6 Luna');
    expect(helpers.friendlyModelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini');
    expect(helpers.friendlyModelName('gpt-5.2')).toBe('GPT-5.2');
  });

  it('renders a bare alias as its family name', () => {
    expect(helpers.friendlyModelName('opus')).toBe('Opus');
  });

  it('shows an id it does not recognize unchanged, and nothing for no id', () => {
    expect(helpers.friendlyModelName('some-future-model-x')).toBe('some-future-model-x');
    expect(helpers.friendlyModelName('gpt-6-astra-preview-2')).toBe('gpt-6-astra-preview-2');
    expect(helpers.friendlyModelName(null)).toBe('');
    expect(helpers.friendlyModelName(undefined)).toBe('');
  });
});

describe('modelFamilyClass', () => {
  it('is the family for Claude ids and aliases, empty otherwise', () => {
    expect(helpers.modelFamilyClass('claude-opus-5-5')).toBe('opus');
    expect(helpers.modelFamilyClass('sonnet')).toBe('sonnet');
    expect(helpers.modelFamilyClass('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(helpers.modelFamilyClass('gpt-5.6-sol')).toBe('');
    expect(helpers.modelFamilyClass(null)).toBe('');
  });

  it('never yields a class containing markup or spaces (it lands in a class attribute)', () => {
    expect(helpers.modelFamilyClass('"><img src=x onerror=1> opus')).toBe('opus');
    expect(helpers.modelFamilyClass('"><img src=x onerror=1>')).toBe('');
  });
});

describe('visibleModels', () => {
  const models = ['claude-opus-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'opus'];

  it('hides a dated id whose undated twin is listed', () => {
    expect(helpers.visibleModels(models, null)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5', 'opus']);
  });

  it('keeps a dated id when it is the current selection', () => {
    expect(helpers.visibleModels(models, 'claude-haiku-4-5-20251001')).toEqual(models);
  });

  it('keeps a dated id that has no undated twin', () => {
    expect(helpers.visibleModels(['claude-haiku-4-5-20251001'], null)).toEqual(['claude-haiku-4-5-20251001']);
  });
});

describe('page wiring', () => {
  it('the model selects show the friendly name and keep the raw id as the value', () => {
    expect(HTML).toContain('for (const m of visibleModels(d.models, selected))');
    expect(HTML).toMatch(/o\.value = m;\s*\n\s*\/\/[^\n]*\n\s*o\.text = friendlyModelName\(m\)/);
  });

  it('badges show the friendly name, carry the raw id as a tooltip, and are escaped', () => {
    expect(HTML).toContain('escapeHtml(friendlyModelName(model))');
    expect(HTML).toContain('title="${escapeHtml(model)}"');
    expect(HTML).toContain('badge.textContent = friendlyModelName(session.model);');
  });

  it('a badge wraps whole, the list row may wrap, and the switch button does not break', () => {
    expect(HTML).toMatch(/\.model-badge, \.machine-badge \{ white-space: nowrap; \}/);
    expect(HTML).toMatch(/\.session-meta \{[^}]*flex-wrap: wrap;/);
    expect(HTML).toMatch(/\.door-model-btn \{[^}]*white-space: nowrap;[^}]*flex-shrink: 0;/);
  });
});

describe('unowned-topic refusal wording', () => {
  it('tells the operator what to do, in plain words', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/topicProfileWriteSurface.ts'), 'utf-8');
    expect(src).toContain('Send one message in this topic first, then switch.');
    expect(src).not.toContain('has no bound operator yet');
  });
});
