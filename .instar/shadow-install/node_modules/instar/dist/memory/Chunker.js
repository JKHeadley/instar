/**
 * Chunker — splits source files into search-friendly chunks.
 *
 * Strategies:
 *   - Markdown: heading-aware, never splits mid-line
 *   - JSON: each top-level key or array element is a chunk
 *   - JSONL: one chunk per line
 *
 * Target ~400 tokens per chunk (~1600 characters),
 * ~80 token overlap (~320 characters).
 */
/**
 * Estimate token count from text (fast ~4 chars/token heuristic).
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/**
 * Chunk markdown text with heading-awareness.
 * Headings (## and above) start new chunks. Chunks respect line boundaries.
 */
export function chunkMarkdown(text, chunkSize = 400, overlap = 80) {
    const maxChars = chunkSize * 4; // ~4 chars per token
    const overlapChars = overlap * 4;
    const lines = text.split('\n');
    const chunks = [];
    let currentLines = [];
    let currentOffset = 0;
    let chunkStartOffset = 0;
    function flushChunk() {
        if (currentLines.length === 0)
            return;
        const chunkText = currentLines.join('\n');
        if (chunkText.trim()) {
            chunks.push({
                text: chunkText,
                offset: chunkStartOffset,
                length: Buffer.byteLength(chunkText, 'utf-8'),
                tokenCount: estimateTokens(chunkText),
            });
        }
        currentLines = [];
    }
    for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');
        const isHeading = /^#{1,3}\s/.test(line);
        const currentText = currentLines.join('\n');
        const wouldExceed = currentText.length + line.length + 1 > maxChars;
        // Start new chunk on heading or size limit
        if ((isHeading || wouldExceed) && currentLines.length > 0) {
            flushChunk();
            // Add overlap from previous chunk
            if (chunks.length > 0 && overlapChars > 0) {
                const prevText = chunks[chunks.length - 1].text;
                const overlapText = prevText.slice(-overlapChars);
                const overlapLines = overlapText.split('\n');
                // Only take complete lines from the overlap
                if (overlapLines.length > 1) {
                    overlapLines.shift(); // Drop partial first line
                    currentLines = overlapLines;
                    chunkStartOffset = currentOffset - Buffer.byteLength(overlapLines.join('\n') + '\n', 'utf-8');
                }
                else {
                    chunkStartOffset = currentOffset;
                }
            }
            else {
                chunkStartOffset = currentOffset;
            }
        }
        if (currentLines.length === 0) {
            chunkStartOffset = currentOffset;
        }
        currentLines.push(line);
        currentOffset += lineBytes;
    }
    // Flush remaining
    flushChunk();
    return chunks;
}
/**
 * Chunk JSON text — each top-level array element or object value becomes a chunk.
 */
export function chunkJson(text) {
    const chunks = [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            // Array: each element is a chunk
            for (const item of parsed) {
                const itemText = JSON.stringify(item, null, 2);
                const offset = text.indexOf(itemText.slice(0, 20));
                chunks.push({
                    text: itemText,
                    offset: Math.max(0, offset),
                    length: Buffer.byteLength(itemText, 'utf-8'),
                    tokenCount: estimateTokens(itemText),
                });
            }
        }
        else if (typeof parsed === 'object' && parsed !== null) {
            // Object: each top-level key is a chunk
            for (const [key, value] of Object.entries(parsed)) {
                const itemText = `${key}: ${JSON.stringify(value, null, 2)}`;
                chunks.push({
                    text: itemText,
                    offset: text.indexOf(`"${key}"`),
                    length: Buffer.byteLength(itemText, 'utf-8'),
                    tokenCount: estimateTokens(itemText),
                });
            }
        }
        else {
            // Primitive: single chunk
            chunks.push({
                text,
                offset: 0,
                length: Buffer.byteLength(text, 'utf-8'),
                tokenCount: estimateTokens(text),
            });
        }
    }
    catch {
        // Invalid JSON: treat as single chunk
        chunks.push({
            text,
            offset: 0,
            length: Buffer.byteLength(text, 'utf-8'),
            tokenCount: estimateTokens(text),
        });
    }
    return chunks;
}
/**
 * Chunk JSONL text — one chunk per line.
 */
export function chunkJsonl(text) {
    const chunks = [];
    let offset = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
            chunks.push({
                text: trimmed,
                offset,
                length: Buffer.byteLength(trimmed, 'utf-8'),
                tokenCount: estimateTokens(trimmed),
            });
        }
        offset += Buffer.byteLength(line + '\n', 'utf-8');
    }
    return chunks;
}
//# sourceMappingURL=Chunker.js.map