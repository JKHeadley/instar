/**
 * SmartChunker — Markdown-aware message chunking.
 *
 * WhatsApp messages have a ~4000 char practical limit. Naive chunking
 * can split code blocks, producing broken halves. This chunker respects
 * markdown structure.
 *
 * Rules:
 * 1. Never split inside a ``` code block (find closing ``` and chunk after it)
 * 2. If a code block exceeds the limit by itself, split at newlines within it
 * 3. Prefer splitting at paragraph boundaries (double newline)
 * 4. Fall back to splitting at single newlines
 * 5. Last resort: split at maxLength boundary
 */
export declare function smartChunk(text: string, maxLength: number): string[];
//# sourceMappingURL=SmartChunker.d.ts.map