/**
 * Single funnel for sending LITERAL text into a tmux pane.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tmux send-keys -l <text>` passes the whole payload as a single argv element.
 * argv is bounded by the OS (`ARG_MAX`, minus environment); on macOS/tmux 3.6a
 * the practical ceiling measured on the affected host is ~16.2 KB — a send of
 * ~16,256 B succeeds and ~16,480 B fails with a bare `command too long`.
 *
 * That ceiling silently capped every large prompt. On 2026-08-04 it took down
 * the entire internal-LLM substrate on one machine: the interactive-pool
 * provider sends its prompt with a single `send-keys -l`, a ~40 KB prompt blew
 * the ceiling, and the resulting failure was classified by `LlmCircuitBreaker`
 * as `provider rate-limited` — so the breaker tripped every 15 minutes (14
 * consecutive trips) and ten LLM-backed components sat at 76-100% error rate,
 * including `MessagingToneGate`, `completion-claim-verify` and
 * `UnjustifiedStopGate`. The diagnosis pointed at quota; the cause was argv.
 *
 * WHY CHUNKING AND NOT `load-buffer`/`paste-buffer`
 * -------------------------------------------------
 * `load-buffer` + `paste-buffer` has no size limit and was the obvious remedy,
 * but this codebase deliberately avoids it: see the bracketed-paste branch in
 * `SessionManager.sendTextToPane`, whose comment records that the buffer route
 * "completely avoids load-buffer/paste-buffer and their TCC prompts" (macOS
 * privacy consent dialogs, which an unattended agent cannot answer). Chunking
 * keeps the existing transport and inherits none of that risk.
 *
 * Chunking also composes with bracketed paste: everything a terminal receives
 * between `\e[200~` and `\e[201~` is treated as ONE paste regardless of how
 * many writes delivered it, so a caller that already wraps its payload keeps
 * its newline semantics unchanged.
 *
 * MEASURED (2026-08-04, tmux 3.6a / darwin, 39,992 B payload):
 *   - single `send-keys -l`      -> `command too long`
 *   - chunked at 8,000 B (5 sends) -> pane received 39,992 B, byte-exact,
 *     head and tail markers both present.
 *
 * This module is PURE (`chunkLiteralForTmux`) plus a thin argv builder, so the
 * boundary logic is unit-testable without tmux.
 */
/*
 * RULE 3: EXEMPT — argv construction, not state detection.
 *
 * The pattern match fires on the `send-keys` literal in `buildLiteralSendArgs`,
 * but this module only BUILDS an argument vector and splits a string on byte
 * boundaries. It never spawns tmux, never reads a pane, and never infers
 * session or provider state, so there is no upstream surface whose drift could
 * silently invalidate a heuristic here. Its correctness is fully determined by
 * pure input/output and is pinned by tests/unit/tmux-literal-send.test.ts plus a
 * real-pane byte-exactness check in
 * tests/integration/tmux-literal-send-ceiling.test.ts.
 */

/**
 * Bytes per `send-keys -l` payload.
 *
 * Deliberately ~half the measured ~16.2 KB ceiling. The ceiling is a function
 * of `ARG_MAX` MINUS the caller's environment block, so it is not a constant
 * across machines or across a single machine's lifetime — a fat environment
 * lowers it. Half leaves room for that variance plus the fixed argv overhead
 * (`send-keys`, `-t`, target, `-l`, `--`).
 */
export const TMUX_SEND_KEYS_CHUNK_BYTES = 8000;

/**
 * Split `text` into chunks that are each at most `chunkBytes` **bytes** when
 * UTF-8 encoded, without ever splitting a multi-byte code point or a surrogate
 * pair.
 *
 * Byte-based (not character-based) because the ceiling is an argv BYTE limit;
 * a string of 8,000 emoji is ~32,000 bytes and would still blow it.
 *
 * Returns `[]` for empty input — callers should treat that as "nothing to
 * send" rather than sending one empty chunk.
 */
export function chunkLiteralForTmux(
  text: string,
  chunkBytes: number = TMUX_SEND_KEYS_CHUNK_BYTES,
): string[] {
  if (!text) return [];
  if (chunkBytes < 1) {
    throw new Error(`chunkLiteralForTmux: chunkBytes must be >= 1 (got ${chunkBytes})`);
  }

  const encoder = new TextEncoder();
  // Fast path: the overwhelming majority of sends are far below the ceiling,
  // and this avoids walking the string at all for them.
  if (encoder.encode(text).length <= chunkBytes) return [text];

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  // Iterating the string yields whole code points (surrogate pairs stay
  // together), so a chunk boundary can never land inside one.
  for (const codePoint of text) {
    const size = encoder.encode(codePoint).length;
    if (size > chunkBytes) {
      throw new Error(
        `chunkLiteralForTmux: single code point is ${size} bytes, exceeding chunkBytes=${chunkBytes}`,
      );
    }
    if (currentBytes + size > chunkBytes) {
      chunks.push(current);
      current = codePoint;
      currentBytes = size;
    } else {
      current += codePoint;
      currentBytes += size;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Build the argv for one literal `send-keys` call.
 *
 * `--` terminates option parsing so payload beginning with `-` can never be
 * read as a flag (the hardening already applied at `SessionManager.sendInput`,
 * made uniform here).
 *
 * `target` is passed through verbatim — callers are responsible for the
 * `=session:` trailing-colon form, which is load-bearing on tmux 3.6a.
 */
export function buildLiteralSendArgs(target: string, chunk: string): string[] {
  return ['send-keys', '-t', target, '-l', '--', chunk];
}

/**
 * True when `text` would exceed a single `send-keys -l` payload — i.e. the
 * caller MUST chunk. Exposed so callers and tests can assert the boundary
 * without duplicating the encoding rule.
 */
export function exceedsSingleSend(
  text: string,
  chunkBytes: number = TMUX_SEND_KEYS_CHUNK_BYTES,
): boolean {
  return new TextEncoder().encode(text).length > chunkBytes;
}
