// A promise can carry exact action destinations from its source. Older records
// may predate that field; keep the verified rulebook requests actionable.

const GITHUB_PR = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*(?:\/files)?$/;

const RULEBOOK_REQUEST = 'Approve rulebook changes (2.0 PR 182, 1.x PR 2380)';
const FOLLOWUP_RULEBOOK_REQUEST = 'Confirm reworded-correction grouping after server update; land 1.x rulebook PR 2380';
const RULEBOOK_ORIGIN = 'm_03b30f5b32c6ef3eb0afd3ca7054e252';

const legacyRulebookLinks = [
  { label: 'Review 1.x PR 2380 on GitHub', href: 'https://github.com/JKHeadley/instar/pull/2380/files', primary: true },
  { label: 'View merged 2.0 PR 182', href: 'https://github.com/JKHeadley/instar-2/pull/182/files' },
];

/** Exact, safe destinations for an operator action; never infer a repo from a PR number. */
export function promiseActionLinks(c) {
  if (Array.isArray(c?.actionLinks)) {
    return c.actionLinks.slice(0, 5).filter((link) =>
      link && typeof link.label === 'string' && link.label.trim().length > 0 && link.label.length <= 90
      && typeof link.href === 'string' && GITHUB_PR.test(link.href),
    ).map((link) => ({ label: link.label.trim(), href: link.href, primary: link.primary === true }));
  }
  if (c?.id === 'CMT-1043' && c.originMachineId === RULEBOOK_ORIGIN && c.userRequest === RULEBOOK_REQUEST) {
    return legacyRulebookLinks;
  }
  if (c?.id === 'CMT-1122' && c.originMachineId === RULEBOOK_ORIGIN && c.userRequest === FOLLOWUP_RULEBOOK_REQUEST) {
    return [legacyRulebookLinks[0]];
  }
  return [];
}
