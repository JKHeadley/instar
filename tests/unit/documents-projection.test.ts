import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { projectText, projectTextWith, PROJECTION_VERSION } from '../../src/documents/projection.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('projectText (projection version 1 golden corpus)', () => {
  const cases: Array<[string, string, string]> = [
    ['headings and paragraphs', '# One\n\nPara   with\nsoft  break.\n\n## Two\n\nMore', 'One\nPara with soft break.\nTwo\nMore'],
    ['emphasis, links, code spans, escapes', 'A *b* **c** ~~d~~ [e](http://x "t") `f<g` \\*h', 'A b c d e f<g *h'],
    ['tight and nested lists, task items', '- [ ] one\n- two\n  - nested\n- [x] three', 'one\ntwo\nnested\nthree'],
    ['loose ordered list', '1. first\n\n2. second para\n\n   continued', 'first\nsecond para\ncontinued'],
    ['table rows, cells joined', '| a | b |\n|---|---|\n| 1 | **2** |\n| x y |  z |', 'a | b\n1 | 2\nx y | z'],
    ['fenced code block text', '```js\nconst x = 1;\n  y()\n```\n\nafter', 'const x = 1; y()\nafter'],
    ['indented code block', '    let a\n    let b\n\ntext', 'let a let b\ntext'],
    ['block and inline html kept raw', '<div>\nraw\n</div>\n\nx <b>hi</b> y', '<div> raw </div>\nx <b>hi</b> y'],
    ['blockquote, image alt, hr dropped', '> quoted *line*\n\n---\n\n![the alt](i.png) end', 'quoted line\nthe alt end'],
    ['entities stay as source', 'a &amp; b &lt;c&gt;', 'a &amp; b &lt;c&gt;'],
    ['empty document', '', ''],
  ];
  for (const [name, md, expected] of cases) {
    it(name, () => expect(projectText(md).text).toBe(expected));
  }

  it('blocks index the text and carry stable 16-hex hints', () => {
    const p = projectText('# H\n\nalpha\n\nbeta\n\n## S\n\ngamma');
    expect(p.blocks.map((b) => p.text.slice(b.start, b.end))).toEqual(['H', 'alpha', 'beta', 'S', 'gamma']);
    for (const b of p.blocks) expect(b.hint).toMatch(/^[0-9a-f]{16}$/);
    expect(p.blocks[1].hint).toBe(sha(JSON.stringify([['H'], 1])).slice(0, 16));
    expect(p.blocks[4].hint).toBe(sha(JSON.stringify([['H', 'S'], 1])).slice(0, 16));
    // Same heading path + ordinal in another document → same hint (edit elsewhere keeps it).
    const q = projectText('# H\n\nchanged\n\nbeta edited\n\n## S\n\ngamma');
    expect(q.blocks.map((b) => b.hint)).toEqual(p.blocks.map((b) => b.hint));
  });

  it('is deterministic and the pure variant matches', () => {
    const md = '# T\n\n- a\n- b\n\n| x | y |\n|-|-|\n| 1 | 2 |\n\n```\ncode\n```';
    const a = projectText(md);
    expect(projectText(md)).toEqual(a);
    expect(projectTextWith(md, sha)).toEqual(a);
  });

  it('throws on an unknown projection version', () => {
    expect(PROJECTION_VERSION).toBe(1);
    expect(() => projectText('x', 2)).toThrow(/projectionVersion/);
  });
});
