/** The link-a-computer QR encoder (dashboard/docs/qr-code.js; spec §3.6a). */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { alignmentPositions, formatBits, penalty, qrMatrix, qrSvg, rsEncode, versionBits } from '../../dashboard/docs/qr-code.js';

const bin = (n: number, w: number) => n.toString(2).padStart(w, '0');

// Capacity in bytes (byte mode) per version, level M — ISO 18004 Table 7.
const BYTES_M: Record<number, number> = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 10: 213, 13: 331, 14: 362, 20: 666 };

describe('Reed–Solomon', () => {
  it('matches the ISO 18004 Annex I example (1-M, "01234567")', () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(rsEncode(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });
});

describe('format and version information', () => {
  // ISO 18004 Table C.1 (masked format strings).
  const TABLE: Record<string, string[]> = {
    L: ['111011111000100', '111001011110011', '111110110101010', '111100010011101', '110011000101111', '110001100011000', '110110001000001', '110100101110110'],
    M: ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'],
    Q: ['011010101011111', '011000001101000', '011111100110001', '011101000000110', '010010010110100', '010000110000011', '010111011011010', '010101111101101'],
    H: ['001011010001001', '001001110111110', '001110011100111', '001100111010000', '000011101100010', '000001001010101', '000110100001100', '000100000111011'],
  };
  it('computes every format string in the published table', () => {
    for (const [ecl, row] of Object.entries(TABLE)) row.forEach((want, mask) => expect(bin(formatBits(ecl, mask), 15), `${ecl}/${mask}`).toBe(want));
  });
  it('M/0 is 101010000010010 and L/0 is 111011111000100', () => {
    expect(bin(formatBits('M', 0), 15)).toBe('101010000010010');
    expect(bin(formatBits('L', 0), 15)).toBe('111011111000100');
  });
  it('computes the published version strings (Table D.1)', () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(10)).toBe(0x0a4d3);
    expect(versionBits(20)).toBe(0x149a6);
  });
  it('places alignment patterns where Annex E says', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(16)).toEqual([6, 26, 50, 74]);
    expect(alignmentPositions(20)).toEqual([6, 34, 62, 90]);
  });
});

function finderAt(m: boolean[][], x0: number, y0: number) {
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
    const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    if (m[y0 + dy][x0 + dx] !== (d !== 2)) return false;
  }
  return true;
}
const versionOf = (m: boolean[][]) => (m.length - 17) / 4;
/** Reads the format bits back from around the top-left finder. */
function readFormat(m: boolean[][]) {
  const at = (x: number, y: number) => (m[y][x] ? 1 : 0);
  const bits = [at(8, 0), at(8, 1), at(8, 2), at(8, 3), at(8, 4), at(8, 5), at(8, 7), at(8, 8), at(7, 8), at(5, 8), at(4, 8), at(3, 8), at(2, 8), at(1, 8), at(0, 8)];
  return bits.reduce((acc, b, i) => acc | (b << i), 0);
}

describe('matrix structure', () => {
  const samples = ['a', 'x'.repeat(BYTES_M[1]), 'x'.repeat(BYTES_M[1] + 1), 'é€😀'.repeat(20), 'instar-link:1:' + 'A'.repeat(300), 'z'.repeat(BYTES_M[20])];
  it('picks the smallest version that fits, size 4V+17', () => {
    for (const [v, cap] of Object.entries(BYTES_M)) {
      expect(qrMatrix('q'.repeat(cap), 'M').length).toBe(4 * Number(v) + 17);
      if (Number(v) < 20) expect(versionOf(qrMatrix('q'.repeat(cap + 1), 'M'))).toBeGreaterThan(Number(v));
    }
    expect(qrMatrix('a').length).toBe(21);
  });
  it('refuses text longer than version 20 holds', () => {
    expect(() => qrMatrix('z'.repeat(BYTES_M[20] + 1), 'M')).toThrow('qr-too-long');
  });
  for (const text of samples) {
    it(`has finders, timing, the dark module and format info (${text.length} chars)`, () => {
      const m = qrMatrix(text, 'M');
      const size = m.length; const v = versionOf(m);
      expect(Number.isInteger(v)).toBe(true);
      expect(finderAt(m, 0, 0) && finderAt(m, size - 7, 0) && finderAt(m, 0, size - 7)).toBe(true);
      for (let i = 0; i < 8; i++) { expect(m[7][i]).toBe(false); expect(m[i][7]).toBe(false); } // separators
      for (let i = 8; i < size - 8; i++) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0); }
      expect(m[4 * v + 9][8]).toBe(true);
      const f = readFormat(m);
      const match = [0, 1, 2, 3, 4, 5, 6, 7].filter((mask) => formatBits('M', mask) === f);
      expect(match.length).toBe(1);
      // The second copy agrees with the first.
      let second = 0;
      for (let i = 0; i < 8; i++) second |= (m[8][size - 1 - i] ? 1 : 0) << i;
      for (let i = 8; i < 15; i++) second |= (m[size - 15 + i][8] ? 1 : 0) << i;
      expect(second).toBe(f);
      if (v >= 7) {
        const vb = versionBits(v);
        for (let i = 0; i < 18; i++) {
          const want = ((vb >>> i) & 1) === 1;
          const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
          expect(m[b][a]).toBe(want); expect(m[a][b]).toBe(want);
        }
      }
    });
  }
  it('chooses the mask with the lowest penalty', () => {
    const text = 'instar-link:1:eyJrIjoiQUFBIn0';
    const auto = qrMatrix(text, 'Q');
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => penalty(qrMatrix(text, 'Q', { mask })));
    expect(penalty(auto)).toBe(Math.min(...scores));
  });
  it('works at every level', () => {
    for (const ecl of ['L', 'M', 'Q', 'H']) expect(qrMatrix('hello', ecl).length).toBe(21);
    expect(() => qrMatrix('x', 'Z')).toThrow();
  });
});

describe('qrSvg', () => {
  it('builds an svg with createElementNS only', () => {
    const { window } = new JSDOM('<!doctype html><body></body>');
    const svg = qrSvg(window.document, 'hello', { scale: 5, quiet: 4, label: 'Scan me' });
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Scan me');
    expect(svg.getAttribute('viewBox')).toBe('0 0 29 29');
    expect(svg.getAttribute('width')).toBe('145');
    expect(svg.querySelectorAll('rect')).toHaveLength(1);
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('#ffffff');
    const paths = svg.querySelectorAll('path');
    expect(paths).toHaveLength(1);
    const m = qrMatrix('hello', 'M');
    const dark = m.flat().filter(Boolean).length;
    expect((paths[0].getAttribute('d')!.match(/M/g) || []).length).toBe(dark);
    expect(svg.hasAttribute('style')).toBe(false);
  });
});

describe('round trip through a real decoder (jsQR)', async () => {
  const jsQR = (await import('jsqr')).default as unknown as (data: Uint8ClampedArray, w: number, h: number) => { data: string; version: number } | null;
  const { linkPayload } = await import('../../dashboard/docs/doc-page-model.js');
  /** The matrix as the page draws it: a 4-module white quiet zone, `scale` px per module, RGBA. */
  const render = (m: boolean[][], scale = 4, quiet = 4) => {
    const n = m.length; const side = (n + quiet * 2) * scale;
    const px = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!m[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4;
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0;
      }
    }
    return { px, side };
  };
  const decode = (text: string, opts: { mask?: number; ecl?: string } = {}) => {
    const { px, side } = render(qrMatrix(text, opts.ecl ?? 'M', opts.mask === undefined ? {} : { mask: opts.mask }));
    return jsQR(px, side, side);
  };
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xab)]).toString('base64url');
  const realistic = linkPayload({ browserPublicKey: key, nonce: 'Zx3_kQ9-pL2mN7vB4cR8tY1wE6uI0oAs', machineId: 'm_9f2c4e1a7b3d5f60', host: 'echo-studio.dawn-tunnel.dev' });

  it('decodes back to exactly the text, for short, medium and long inputs and the real link payload', () => {
    expect(realistic.startsWith('instar-link:1:')).toBe(true);
    for (const text of ['A', 'hello', 'https://echo.example.dev/docs/12345678-1234-4234-8234-123456789abc', 'x'.repeat(100), 'é ünïcode ✓', realistic, realistic + realistic.slice(0, 60)]) {
      const r = decode(text);
      expect(r, `decodes ${text.length} chars`).not.toBeNull();
      expect(r!.data).toBe(text);
    }
  });

  it('decodes under every mask and every error-correction level', () => {
    for (let mask = 0; mask < 8; mask++) expect(decode(realistic, { mask })?.data, `mask ${mask}`).toBe(realistic);
    for (const ecl of ['L', 'M', 'Q', 'H']) expect(decode(realistic, { ecl })?.data, `level ${ecl}`).toBe(realistic);
  });
});
