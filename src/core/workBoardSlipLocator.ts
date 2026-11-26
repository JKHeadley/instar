import { isWorkBoardSlipId } from './workBoardSlipPresence.js';

const reviewBase = 'https://instar.sh/link/work-board-slip';

export interface WorkBoardSlipLocator {
  agentOrigin: string;
  slipId: string;
}

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || value !== url.origin && value !== `${url.origin}/`) return null;
    return url.origin;
  } catch {
    return null; // @silent-fallback-ok: an invalid locator is refused without a network request.
  }
}

/** The fragment carries locator data only. The app must resolve the origin against its own pairing. */
export function workBoardSlipReviewUrl(agentOrigin: string, slipId: string): string | null {
  const origin = httpsOrigin(agentOrigin);
  if (!origin || !isWorkBoardSlipId(slipId)) return null;
  const fragment = new URLSearchParams({ v: '1', origin, slip: slipId });
  return `${reviewBase}#${fragment}`;
}

export function parseWorkBoardSlipReviewUrl(input: string): WorkBoardSlipLocator | null {
  if (!input.startsWith(`${reviewBase}#`)) return null;
  const parts = new URLSearchParams(input.slice(reviewBase.length + 1));
  const agentOrigin = parts.get('origin');
  const slipId = parts.get('slip');
  if (!agentOrigin || !slipId || workBoardSlipReviewUrl(agentOrigin, slipId) !== input) return null;
  return { agentOrigin, slipId };
}
