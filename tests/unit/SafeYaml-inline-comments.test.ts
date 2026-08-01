import { describe, it, expect } from 'vitest';
import { parseSafeYaml, extractFrontmatter } from '../../src/core/SafeYaml.js';

function data(yaml: string): Record<string, unknown> {
  const r = parseSafeYaml(yaml);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.data;
}

describe('SafeYaml inline comments', () => {
  // The defect this closes: a spec whose approval was DOCUMENTED on the
  // `approved:` line parsed as a string, so every gate testing
  // `data.approved === true` concluded the spec was not approved. The comment
  // that recorded the approval was what voided it.
  it('parses a boolean carrying an inline comment as a boolean', () => {
    const d = data('approved: true  # operator preapproval, topic 11960, 2026-07-11');
    expect(d.approved).toBe(true);
    expect(typeof d.approved).toBe('boolean');
  });

  it('parses false with an inline comment as false, not a truthy string', () => {
    const d = data('enabled: false # ships dark');
    expect(d.enabled).toBe(false);
  });

  it('parses a number carrying an inline comment as a number', () => {
    const d = data('rounds: 3  # converged');
    expect(d.rounds).toBe(3);
  });

  it('strips the comment from an unquoted string value', () => {
    const d = data('audit: llm-accountability  # tracks ACT-562');
    expect(d.audit).toBe('llm-accountability');
  });

  // The conservative half. A `#` is only a comment when it starts the value or
  // follows whitespace, and never inside quotes. These must NOT be stripped.
  it('keeps a # that is part of the value (no preceding whitespace)', () => {
    const d = data('url: http://host/path#fragment');
    expect(d.url).toBe('http://host/path#fragment');
  });

  it('keeps a # inside a double-quoted scalar', () => {
    const d = data('title: "sharp # sign"');
    expect(d.title).toBe('sharp # sign');
  });

  it('keeps a # inside a single-quoted scalar', () => {
    const d = data("title: 'sharp # sign'");
    expect(d.title).toBe('sharp # sign');
  });

  it('strips a comment that follows a quoted scalar', () => {
    const d = data('approved-by: "Justin (operator preapproval)"  # transcribed');
    expect(d['approved-by']).toBe('Justin (operator preapproval)');
  });

  it('strips a comment after a flow sequence but keeps # inside its elements', () => {
    const d = data('tags: [alpha, "b # c"]  # trailing note');
    expect(d.tags).toEqual(['alpha', 'b # c']);
  });

  // Same class, second site: block-sequence items carry the identical defect.
  it('strips inline comments from block-sequence items', () => {
    const d = data(['tags:', '  - alpha  # first', '  - beta'].join('\n'));
    expect(d.tags).toEqual(['alpha', 'beta']);
  });

  it('leaves values without comments byte-identical', () => {
    const d = data(['approved: true', 'audit: plain-value', 'rounds: 3'].join('\n'));
    expect(d).toEqual({ approved: true, audit: 'plain-value', rounds: 3 });
  });

  it('applies through extractFrontmatter, the path the gates actually use', () => {
    const src = ['---', 'approved: true  # topic 11960', 'approved-date: "2026-07-11"', '---', '# Body'].join(
      '\n'
    );
    const { frontmatter } = extractFrontmatter(src);
    expect(frontmatter?.approved).toBe(true);
    expect(frontmatter?.['approved-date']).toBe('2026-07-11');
  });

  it('still treats a whole-line comment as a comment, not a key', () => {
    const d = data(['# a leading note', 'approved: true'].join('\n'));
    expect(d).toEqual({ approved: true });
  });
});
