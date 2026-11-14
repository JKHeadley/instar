/**
 * A deterministic stand-in for the local embedding model (conversation meaning search tests).
 *
 * Words in the same concept group share a dimension, so "spaceship liftoff" lands near "rocket
 * launch" although no word is shared; every other word gets its own hashed dimension. Vectors are
 * L2-normalized like the real model's. `fail` makes embed() throw (the model failing to load).
 */
import type { Embedder } from '../../src/memory/ConversationEmbeddingIndex.js';

const CONCEPTS: Record<string, string[]> = {
  space: ['rocket', 'rockets', 'launch', 'launched', 'spaceship', 'liftoff', 'orbit', 'shuttle'],
  money: ['money', 'budget', 'cost', 'costs', 'price', 'dollars', 'spend', 'spending'],
  food: ['dinner', 'food', 'meal', 'pizza', 'eat', 'lunch'],
  weather: ['rain', 'storm', 'weather', 'sunny', 'forecast'],
};
const WORD_TO_DIM = new Map<string, number>();
Object.values(CONCEPTS).forEach((words, i) => { for (const w of words) WORD_TO_DIM.set(w, i); });

function dimOf(word: string, dims: number): number {
  const c = WORD_TO_DIM.get(word);
  if (c !== undefined) return c;
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) { h ^= word.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 16 + (Math.abs(h) % (dims - 16));
}

export function fakeVector(text: string, dims = 384): Float32Array {
  const v = new Float32Array(dims);
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const d = dimOf(m[0], dims);
    // Concept words weigh more than filler, as a real model weighs content words.
    v[d] += d < 16 ? 3 : 0.4;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

export class FakeEmbedder implements Embedder {
  readonly dimensions = 384;
  calls: string[] = [];
  fail = false;
  async embed(text: string): Promise<Float32Array> {
    if (this.fail) throw new Error('model failed to load');
    this.calls.push(text);
    return fakeVector(text, this.dimensions);
  }
}
