import { CHIEF_OF_STAFF_PR_REPO } from './ChiefOfStaffPrSearch.js';
import { searchTerms } from './conversationKeywordSearch.js';
import { fetchGitHubGraphql } from './githubRuntime.js';

// Only these published paths participate. Expanding this list expands public
// discovery coverage and requires an explicit review of the new paths.
const SPECS = [
  'docs/specs/canonical-records-and-work-discovery.md',
  'docs/specs/chief-of-staff-pr-discovery.md',
  'docs/specs/TESTING-INTEGRITY-SPEC.md',
] as const;
const SPECS_DIRECTORY = 'docs/specs';
const MAX_TREE_ENTRIES = 4_096;
const MAX_RESPONSE_BYTES = 512 * 1_024;
const QUERY = `query PublishedWorkSpecs {
  repository(owner: "JKHeadley", name: "instar", followRenames: false) {
    nameWithOwner
    visibility
    defaultBranchRef {
      target {
        __typename
        ... on Commit {
          oid
          specs: file(path: "${SPECS_DIRECTORY}") {
            path type mode
            object {
              __typename
              ... on Tree { entries { name type mode } }
            }
          }
        }
      }
    }
  }
}`;

type TreeEntry = { name?: string; type?: string; mode?: number };
type CommitTarget = {
  __typename?: string;
  oid?: string;
  specs?: { path?: string; type?: string; mode?: number; object?: { __typename?: string; entries?: TreeEntry[] } | null } | null;
};
type GitHubSpecs = {
  repository?: { nameWithOwner?: string; visibility?: string; defaultBranchRef?: { target?: CommitTarget | null } | null } | null;
};

export async function readPublishedWorkSpecs(readToken: () => string | null, query: string) {
  const scope = { repository: CHIEF_OF_STAFF_PR_REPO, corpus: 'allowlisted-default-branch-paths' } as const;
  const unavailable = () => ({ hits: [], coverage: { ...scope, status: 'unavailable' as const } });
  try {
    const token = readToken();
    if (!token) return unavailable();
    const data = await fetchGitHubGraphql<GitHubSpecs>({ token, query: QUERY, timeoutMs: 4_000, maxResponseBytes: MAX_RESPONSE_BYTES });
    if (readToken() !== token) return unavailable();
    const repo = data.repository;
    const target = repo?.defaultBranchRef?.target;
    if (repo?.visibility !== 'PUBLIC' || repo.nameWithOwner !== CHIEF_OF_STAFF_PR_REPO
      || target?.__typename !== 'Commit' || typeof target.oid !== 'string' || !/^[a-f0-9]{40}$/.test(target.oid)) return unavailable();

    const tree = target.specs;
    const entries = tree?.object?.entries;
    if (tree?.path !== SPECS_DIRECTORY || tree.type !== 'tree' || tree.mode !== 0o040000
      || tree.object?.__typename !== 'Tree' || !Array.isArray(entries)
      || !entries.length || entries.length >= MAX_TREE_ENTRIES) return unavailable();

    // GitHub reports a missing Commit.file as a top-level GraphQL error.
    // Read the one published tree to distinguish absent paths from failed reads.
    const byName = new Map<string, TreeEntry>();
    for (const entry of entries) {
      if (typeof entry?.name !== 'string' || byName.has(entry.name)) return unavailable();
      byName.set(entry.name, entry);
    }
    const commit = target.oid;
    const terms = searchTerms(query);
    const observedAt = new Date().toISOString();
    const hits = [];
    let incomplete = false;
    let validated = 0;
    for (const path of SPECS) {
      const entry = byName.get(path.slice(SPECS_DIRECTORY.length + 1));
      if (!entry) {
        validated++;
        continue;
      }
      if (entry.type !== 'blob' || entry.mode !== 0o100644) {
        incomplete = true;
        continue;
      }
      validated++;
      const name = path.slice(SPECS_DIRECTORY.length + 1, -'.md'.length).toLowerCase();
      if (terms.length && terms.every(term => name.includes(term))) {
        hits.push({
          kind: 'published-spec' as const, repository: CHIEF_OF_STAFF_PR_REPO, path, commit, observedAt,
          url: `https://github.com/${CHIEF_OF_STAFF_PR_REPO}/blob/${commit}/${path}`, matchedBy: 'path' as const,
        });
      }
    }
    if (!validated) return unavailable();
    return { hits, coverage: { ...scope, status: incomplete ? 'partial' as const : 'fresh' as const, commit, observedAt } };
  } catch {
    return unavailable();
  }
}
