import type { WebKBuildEnrollment } from './TelegramWebKDriver.js';

/**
 * Telegram Web K builds whose driver contracts were reviewed against their
 * public source maps (docs/specs/reports/telegram-message-origin-evidence/).
 * The trusted enrollment entrypoint admits ONLY a build listed here, and only
 * when the authenticated read-only canary observes exactly these asset names
 * and digests. Adding a build is a reviewed code change, never a runtime input.
 * Newest first.
 */
export interface ReviewedWebKBuild extends WebKBuildEnrollment { evidence: string; }

export const REVIEWED_WEB_K_BUILDS: readonly ReviewedWebKBuild[] = Object.freeze<ReviewedWebKBuild[]>([
  {
    buildId: 'web-k-2.2-684',
    evidence: 'docs/specs/reports/telegram-message-origin-evidence/web-k-2.2-684-review.md',
    criticalAssets: ['apiManagerProxy-BsT2jiCe.js', 'app-Y8QFA5bv.js', 'index-kWWFxlHg.js'],
    assetDigests: {
      'apiManagerProxy-BsT2jiCe.js': '6f8d5d5bc0b7ce65da1112f443d8ab4a52af11054b880648c5d0a29aee6a9b63',
      'app-Y8QFA5bv.js': '4e877485f8e9629d0b723468fac7291d47b02fb01fa35493f1b8cda1aafd0e72',
      'index-kWWFxlHg.js': '1c43fc11afbbaa87272ce5df6b9d1157352cf1142187dfa099782e23f2b1b59d',
    },
  },
  {
    buildId: 'web-k-2.2-679',
    evidence: 'docs/specs/reports/telegram-message-origin-evidence/web-k-2.2-679-review.md',
    criticalAssets: ['apiManagerProxy-DYhbs4ln.js', 'app-DVSixCDs.js', 'index-xJZhS8vI.js'],
    assetDigests: {
      'apiManagerProxy-DYhbs4ln.js': '70513b1b70daee74142dce7f1452c95f695465812b7bb40340aa18fa4ca1932a',
      'app-DVSixCDs.js': 'fb82ff310b30bfd265e4ada88a8c5e2e6eb7e8bc971543cb4200bf3f4169bf6b',
      'index-xJZhS8vI.js': '2faf42121fb7488fe20708d958a439e1cdddfffe95dd2de3e886bc465be455a9',
    },
  },
  {
    buildId: 'web-k-2.2-676',
    evidence: 'docs/specs/reports/telegram-message-origin-evidence/authenticated-web-k-canary.json',
    criticalAssets: ['apiManagerProxy-DVXobuyu.js', 'app-BSCNxN1b.js', 'index-CBuWbkpt.js'],
    assetDigests: {
      'apiManagerProxy-DVXobuyu.js': 'dd0c085f588933412dac28f9cd05a4eac870c767873988681bb50ce74d66f23c',
      'app-BSCNxN1b.js': '29cc14416104de928e50e7cf3e2f91948890f8b35025dfb9e3c28d167d984ed6',
      'index-CBuWbkpt.js': 'f96a8174e8a530c951809477124f8000a2463adfc7b215d3a97e17350fd12e93',
    },
  },
]);

/** The reviewed build whose exact asset names and digests equal the observation, if any. */
export function matchReviewedWebKBuild(observed: { criticalAssets: string[]; assetDigests: Record<string, string> },
  reviewed: readonly ReviewedWebKBuild[] = REVIEWED_WEB_K_BUILDS): ReviewedWebKBuild | undefined {
  const names = [...new Set(observed.criticalAssets)].sort();
  if (names.length !== observed.criticalAssets.length) return undefined;
  return reviewed.find(build => {
    const expected = [...build.criticalAssets].sort();
    return expected.length === names.length && expected.every((name, i) => name === names[i]
      && build.assetDigests[name] === observed.assetDigests[name]);
  });
}

/** The enrolled build list: the observed build first, then at most one other
 * previously enrolled build that is still on the reviewed list (max two). */
export function nextSupportedBuilds(observed: ReviewedWebKBuild, previous: readonly WebKBuildEnrollment[] = [],
  reviewed: readonly ReviewedWebKBuild[] = REVIEWED_WEB_K_BUILDS): WebKBuildEnrollment[] {
  const strip = (b: WebKBuildEnrollment): WebKBuildEnrollment => ({ buildId: b.buildId, criticalAssets: [...b.criticalAssets], assetDigests: { ...b.assetDigests } });
  const keep = previous.map(b => matchReviewedWebKBuild(b, reviewed)).find(b => b && b.buildId !== observed.buildId);
  return [strip(observed), ...(keep ? [strip(keep)] : [])];
}
