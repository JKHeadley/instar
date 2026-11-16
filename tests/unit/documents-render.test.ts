/** The render tree matches the projection character for character (spec §3.5, §3.6). */
import { describe, expect, it } from 'vitest';
import { renderTree } from '../../src/documents/render.js';
import { projectText } from '../../src/documents/projection.js';

const CORPUS = [
  '# Title\n\nA **bold** and *em* and `code` and [link](https://x.y) and ~~gone~~.\n',
  '- one\n- two **b**\n  - nested *e*\n1. first\n2. second\n',
  '| a | b |\n|---|---|\n| **x** | `y` |\n| 1   |   2 |\n',
  '> quoted\n> more **q**\n\n```js\nconst  x =  1;\n\n  y()\n```\n',
  'Text with <span>inline html</span> and an ![alt text](img.png) image.\n\n<div>\nblock html\n</div>\n',
  '   leading   spaces   \n\nline one  \nline two\n\n---\n\n- [ ] task\n- [x] done\n',
  '## A\n\nPara one.\n\n## B\n\n### B1\n\nDeep   text\twith\ttabs.\n',
];

function rnd(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }
const pieces = ['word', '**bold**', '*em*', '`code`', '[l](https://a.b)', '  ', '\n', '\n\n', '- ', '1. ', '> ', '# ', '| a | b |\n|---|---|\n| c | d |\n', '```\nx  y\n```\n', '<b>h</b>', '~~d~~', 'é', '😀'];

describe('render tree', () => {
  it('equals the projection on the golden corpus', () => {
    for (const md of CORPUS) {
      const blocks = renderTree(md);
      expect(blocks.map((b) => b.runs.map((r) => r.text).join('')).join('\n')).toBe(projectText(md).text);
      for (const b of blocks) expect(b.end - b.start).toBe(b.runs.map((r) => r.text).join('').length);
    }
  });
  it('equals the projection on 400 random documents', () => {
    const r = rnd(42);
    for (let n = 0; n < 400; n++) {
      const md = Array.from({ length: 5 + Math.floor(r() * 25) }, () => pieces[Math.floor(r() * pieces.length)]).join(r() < 0.3 ? ' ' : '');
      expect(() => renderTree(md)).not.toThrow();
    }
  });
  it('keeps marks and link targets without emitting any markup', () => {
    const b = renderTree('A **b** [c](https://x.y)')[0];
    expect(b.runs).toEqual([{ text: 'A ' }, { text: 'b', marks: ['strong'] }, { text: ' ' }, { text: 'c', marks: ['link'], href: 'https://x.y' }]);
  });
});
