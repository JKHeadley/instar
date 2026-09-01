import crypto from 'node:crypto';

export interface CodexComposerFrame {
  /** Full visible viewport with SGR attributes preserved. */
  ansiViewport: string;
  /** Same viewport with tmux joining only soft-wrapped physical rows. */
  joinedViewport: string;
  cursorX: number;
  cursorY: number;
  width: number;
  height: number;
  alternateOn: boolean;
  paneInMode: boolean;
  /** Identical metadata sampled immediately before and after both captures. */
  stableMetadata: boolean;
}

export type CodexComposerObservation = 'present' | 'cleared' | 'unknown';
export const CODEX_COMPOSER_ADAPTER_VERSION = 'codex-0.2xx-primary-v1';

/**
 * Pinned adapter for the Codex 0.2xx bottom composer layout. It deliberately
 * accepts only a complete visible viewport and the prompt/status geometry
 * observed on both the primary and alternate tmux screens; the screen mode is
 * an explicit sampled fact, never inferred from missing text.
 */
export function observeCodexComposerFrame(
  frame: CodexComposerFrame | null,
  expectedHmac: string,
  hmacKey: string,
  maxBytes = 256 * 1024,
): CodexComposerObservation {
  if (!frame || !frame.stableMetadata || frame.paneInMode || frame.alternateOn) return 'unknown';
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
    || frame.width < 20 || frame.height < 6 || frame.cursorX < 0 || frame.cursorY < 0
    || frame.cursorX >= frame.width || frame.cursorY >= frame.height) return 'unknown';
  if (Buffer.byteLength(frame.ansiViewport, 'utf8') > maxBytes
    || Buffer.byteLength(frame.joinedViewport, 'utf8') > maxBytes
    || frame.ansiViewport.includes('\uFFFD') || frame.joinedViewport.includes('\uFFFD')) return 'unknown';

  const raw = parseAnsiDimLines(frame.ansiViewport);
  if (raw.length !== frame.height) return 'unknown';
  const cursorLine = raw[frame.cursorY];
  if (!cursorLine) return 'unknown';
  let promptY = frame.cursorY;
  while (promptY >= 0 && !raw[promptY].text.startsWith('› ')) {
    if (!raw[promptY].text.startsWith('  ') || raw[promptY].text.trim() === '') return 'unknown';
    promptY -= 1;
  }
  if (promptY < 0) return 'unknown';
  const promptLine = raw[promptY];
  // Approval/onboarding and active-turn surfaces are never ready composers.
  const visible = raw.map((line) => line.text).join('\n');
  if (/esc to interrupt|Yes, I accept|Press enter to continue|approval required/i.test(visible)) return 'unknown';
  const rawStatusY = raw.findIndex((line, index) => index > promptY
    && /^  \S.+\s·\s.+\s·\s/.test(line.text));
  if (rawStatusY < promptY + 2 || raw[rawStatusY - 1].text.trim() !== ''
    || frame.cursorY >= rawStatusY - 1) return 'unknown';

  const joined = stripAnsi(frame.joinedViewport).replace(/\r/g, '').split('\n');
  const promptCandidates = joined
    .map((line, index) => line.startsWith('› ') ? index : -1)
    .filter((index) => index >= 0);
  // The joined capture includes scrollback only when requested; production
  // captures the visible viewport. Exactly one composer prompt is mandatory.
  if (promptCandidates.length !== 1) return 'unknown';
  const promptIndex = promptCandidates[0];
  const statusIndex = joined.findIndex((line, index) => index > promptIndex
    && /^  \S.+\s·\s.+\s·\s/.test(line));
  if (statusIndex < promptIndex + 2 || joined[statusIndex - 1].trim() !== '') return 'unknown';

  const joinedComposer = joined.slice(promptIndex, statusIndex - 1);
  const first = joinedComposer[0].slice(2);
  const continuation = joinedComposer.slice(1).map((line) => line.startsWith('  ') ? line.slice(2) : line);
  const envelope = [first, ...continuation].join('\n').replace(/[ \t]+$/gm, '');
  const nonWhitespace = raw.slice(promptY, frame.cursorY + 1).flatMap((line) =>
    [...line.text.slice(2)].map((ch, index) => ({ ch, dim: line.dim.slice(2)[index] })),
  ).filter(({ ch }) => !/\s/.test(ch));
  const allDim = nonWhitespace.length > 0 && nonWhitespace.every(({ dim }) => dim === true);

  if (allDim) {
    // Placeholder/ghost text is a positive empty composer only at the input
    // origin. A cursor elsewhere means selection/modal/raced geometry.
    return frame.cursorY === promptY && frame.cursorX === 2
      ? 'cleared' : 'unknown';
  }
  if (!envelope || nonWhitespace.some(({ dim }) => dim === true)) return 'unknown';
  if (frame.cursorX < 2) return 'unknown';
  return hmacEnvelope(envelope, hmacKey) === expectedHmac ? 'present' : 'unknown';
}

interface AnsiDimLine { text: string; dim: boolean[] }

function parseAnsiDimLines(ansi: string): AnsiDimLine[] {
  const lines: AnsiDimLine[] = [{ text: '', dim: [] }];
  let dim = false;
  for (let i = 0; i < ansi.length;) {
    if (ansi[i] === '\x1b') {
      const csi = /^\x1b\[([0-9;:]*)([@-~])/.exec(ansi.slice(i, i + 96));
      if (!csi) return [];
      if (csi[2] === 'm') {
        const params = csi[1] === '' ? ['0'] : csi[1].split(';');
        for (let j = 0; j < params.length; j++) {
          const head = params[j].split(':')[0];
          if ((head === '38' || head === '48' || head === '58') && !params[j].includes(':')) {
            if (params[j + 1] === '5') j += 2;
            else if (params[j + 1] === '2') j += 4;
          } else if (head === '' || head === '0' || head === '22') dim = false;
          else if (head === '2') dim = true;
        }
      }
      i += csi[0].length;
    } else if (ansi[i] === '\n') {
      lines.push({ text: '', dim: [] }); i++;
    } else if (ansi[i] === '\r') i++;
    else {
      const line = lines[lines.length - 1];
      line.text += ansi[i]; line.dim.push(dim); i++;
    }
  }
  if (ansi.endsWith('\n') && lines.at(-1)?.text === '') lines.pop();
  return lines;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;:?>]*[ -/]*[@-~]/g, '');
}

function hmacEnvelope(text: string, key: string): string {
  return crypto.createHmac('sha256', key)
    .update(text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\n$/, ''))
    .digest('hex');
}
