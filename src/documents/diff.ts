/**
 * Instar Documents — word-level compare (spec docs/specs/instar-document-viewer.md §3.5).
 *
 * In-repo Myers O(ND) diff (linear-space, divide-and-conquer middle snake), used in two levels:
 * paragraphs ("\n"-terminated lines) first, then words only inside changed paragraph pairs.
 *
 * Bounds:
 * - Paragraph level: if the edit distance D exceeds `maxOps` (default 20,000) the search stops
 *   after at most ~maxOps/2 rounds of the middle-snake loop, i.e. O((N+M)·maxOps) time and
 *   O(N+M) memory; the result then falls back to common prefix/suffix + one del + one ins
 *   (`truncated: true`).
 * - Word level: each changed paragraph pair is diffed with a 2,000-operation cap, so each pair
 *   costs O((n+m)·2000) time and O(n+m) memory; above the cap that pair is emitted as a whole
 *   del + whole ins (`truncated: true`).
 * Total work is therefore linear in the input size times a constant cap.
 */

export type DiffOp = { op: 'eq' | 'ins' | 'del'; text: string };
export interface DiffResult { ops: DiffOp[]; truncated: boolean }

export const DEFAULT_MAX_OPS = 20_000;
export const PAIR_MAX_OPS = 2_000;

type EditKind = 0 | 1 | 2; // 0 eq, 1 del, 2 ins

/**
 * Myers diff of two integer sequences. Returns a list of [kind, aIndexOrBIndex] steps in order,
 * or null when the edit distance exceeds `maxD`.
 */
export function myers(a: ArrayLike<number>, b: ArrayLike<number>, maxD: number): Array<[EditKind, number]> | null {
  const out: Array<[EditKind, number]> = [];
  let budgetChecked = false;
  let aborted = false;

  const rec = (aLo: number, aHi: number, bLo: number, bHi: number): void => {
    if (aborted) return;
    // Strip common prefix.
    let pre = 0;
    while (aLo + pre < aHi && bLo + pre < bHi && a[aLo + pre] === b[bLo + pre]) pre++;
    // Strip common suffix.
    let suf = 0;
    while (aHi - suf > aLo + pre && bHi - suf > bLo + pre && a[aHi - 1 - suf] === b[bHi - 1 - suf]) suf++;
    for (let i = 0; i < pre; i++) out.push([0, aLo + i]);
    const as = aLo + pre, ae = aHi - suf, bs = bLo + pre, be = bHi - suf;
    const N = ae - as, M = be - bs;
    if (N === 0 || M === 0) {
      for (let i = as; i < ae; i++) out.push([1, i]);
      for (let j = bs; j < be; j++) out.push([2, j]);
    } else {
      const split = middleSnake(as, N, bs, M, budgetChecked ? Infinity : maxD);
      budgetChecked = true;
      if (!split) { aborted = true; return; }
      rec(as, as + split[0], bs, bs + split[1]);
      rec(as + split[0], ae, bs + split[1], be);
    }
    for (let i = suf; i > 0; i--) out.push([0, aHi - i]);
  };

  const middleSnake = (as: number, N: number, bs: number, M: number, limit: number): [number, number] | null => {
    const max = Math.ceil((N + M) / 2);
    const off = max + 1;
    const vf = new Int32Array(2 * max + 3);
    const vb = new Int32Array(2 * max + 3);
    const delta = N - M;
    const odd = (delta & 1) !== 0;
    for (let d = 0; d <= max; d++) {
      if (2 * d - 1 > limit) return null;
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && vf[k - 1 + off] < vf[k + 1 + off]) ? vf[k + 1 + off] : vf[k - 1 + off] + 1;
        let y = x - k;
        while (x < N && y < M && a[as + x] === b[bs + y]) { x++; y++; }
        vf[k + off] = x;
        const c = delta - k;
        if (odd && c >= -(d - 1) && c <= d - 1 && vf[k + off] + vb[c + off] >= N) return [x, y];
      }
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && vb[k - 1 + off] < vb[k + 1 + off]) ? vb[k + 1 + off] : vb[k - 1 + off] + 1;
        let y = x - k;
        while (x < N && y < M && a[as + N - 1 - x] === b[bs + M - 1 - y]) { x++; y++; }
        vb[k + off] = x;
        const c = delta - k;
        if (!odd && c >= -d && c <= d && vf[c + off] + vb[k + off] >= N) return [N - x, M - y];
      }
    }
    return null; // unreachable: D ≤ N+M
  };

  rec(0, a.length, 0, b.length);
  return aborted ? null : out;
}

function intern(tokensA: string[], tokensB: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const id = (s: string): number => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  return [Int32Array.from(tokensA, id), Int32Array.from(tokensB, id)];
}

class OpBuilder {
  ops: DiffOp[] = [];
  push(op: DiffOp['op'], text: string): void {
    if (!text) return;
    const last = this.ops[this.ops.length - 1];
    if (last && last.op === op) last.text += text;
    else this.ops.push({ op, text });
  }
}

/** Paragraph units: each line keeps its trailing "\n", so units concatenate back exactly. */
export function splitParagraphs(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Word units: whitespace runs, letter/number runs, single other characters. */
export function splitWords(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function diffTokens(ta: string[], tb: string[], maxD: number): DiffOp[] | null {
  const [ia, ib] = intern(ta, tb);
  const steps = myers(ia, ib, maxD);
  if (!steps) return null;
  const ob = new OpBuilder();
  for (const [kind, i] of steps) ob.push(kind === 0 ? 'eq' : kind === 1 ? 'del' : 'ins', kind === 2 ? tb[i] : ta[i]);
  return ob.ops;
}

export function diffWords(a: string, b: string, opts: { maxOps?: number } = {}): DiffResult {
  const maxOps = opts.maxOps ?? DEFAULT_MAX_OPS;
  const pa = splitParagraphs(a), pb = splitParagraphs(b);
  const [ia, ib] = intern(pa, pb);
  const steps = myers(ia, ib, maxOps);
  const ob = new OpBuilder();
  let truncated = false;
  if (!steps) {
    truncated = true;
    let pre = 0;
    while (pre < pa.length && pre < pb.length && pa[pre] === pb[pre]) pre++;
    let suf = 0;
    while (suf < pa.length - pre && suf < pb.length - pre && pa[pa.length - 1 - suf] === pb[pb.length - 1 - suf]) suf++;
    ob.push('eq', pa.slice(0, pre).join(''));
    ob.push('del', pa.slice(pre, pa.length - suf).join(''));
    ob.push('ins', pb.slice(pre, pb.length - suf).join(''));
    ob.push('eq', pa.slice(pa.length - suf).join(''));
    return { ops: ob.ops, truncated };
  }
  let dels: string[] = [], inss: string[] = [];
  const flush = (): void => {
    const n = Math.min(dels.length, inss.length);
    for (let i = 0; i < n; i++) {
      const pair = diffTokens(splitWords(dels[i]), splitWords(inss[i]), PAIR_MAX_OPS);
      if (pair) for (const o of pair) ob.push(o.op, o.text);
      else { truncated = true; ob.push('del', dels[i]); ob.push('ins', inss[i]); }
    }
    for (let i = n; i < dels.length; i++) ob.push('del', dels[i]);
    for (let i = n; i < inss.length; i++) ob.push('ins', inss[i]);
    dels = []; inss = [];
  };
  for (const [kind, i] of steps) {
    if (kind === 0) { flush(); ob.push('eq', pa[i]); }
    else if (kind === 1) dels.push(pa[i]);
    else inss.push(pb[i]);
  }
  flush();
  return { ops: ob.ops, truncated };
}

/**
 * Maps an offset in the old text to an offset in the new text. Monotonic non-decreasing.
 * Inside an eq run the offset moves with the text; inside a deleted run it maps to where the
 * deletion happened; offsets past the end clamp to the new text's length.
 */
export function offsetMap(ops: readonly DiffOp[]): (oldOffset: number) => number {
  const segOld: number[] = [], segNew: number[] = [], segEq: boolean[] = [], segLen: number[] = [];
  let o = 0, n = 0;
  for (const op of ops) {
    if (op.op === 'ins') { n += op.text.length; continue; }
    segOld.push(o); segNew.push(n); segEq.push(op.op === 'eq'); segLen.push(op.text.length);
    o += op.text.length;
    if (op.op === 'eq') n += op.text.length;
  }
  const oldLen = o, newLen = n;
  return (off: number): number => {
    if (!(off > 0)) off = 0;
    if (off >= oldLen) return newLen;
    let lo = 0, hi = segOld.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segOld[mid] <= off) lo = mid; else hi = mid - 1; }
    return segEq[lo] ? segNew[lo] + Math.min(off - segOld[lo], segLen[lo]) : segNew[lo];
  };
}
