/** A projection already pruned and verified for the current private destination.
 *  This comparator does not authorize rows, attest links, or establish source freshness.
 */
export interface AuthorizedProjectListSnapshot {
  coverage: 'complete' | 'partial';
  relationsComplete: boolean;
  items: AuthorizedProjectListItem[];
}

interface AuthorizedProjectListItem {
  id: string;
  title: string;
  relation?: { state: 'verified' | 'unresolved'; targetId: string } | { state: 'none' };
}

export type ProjectListComparisonView = 'differences' | 'matches' | 'all';

export interface ProjectListComparisonInput {
  projects?: AuthorizedProjectListSnapshot;
  chiefOfStaff?: AuthorizedProjectListSnapshot;
  view: ProjectListComparisonView;
  observedAt: string;
  maxRows: number;
  maxBytes: number;
}

type CoverageStatus = 'complete' | 'partial' | 'unavailable';
type RowState = 'matched' | 'projects-only' | 'chief-of-staff-only' | 'conflict' | 'counterpart-unchecked';
type DisplayTitle = { title: string; titleTruncated: boolean };
type GroupItem = DisplayTitle & { id: string };
type Group = { state: RowState; projects: GroupItem[]; chiefOfStaff: GroupItem[] };
type DisplayEntry = DisplayTitle & { ordinal: number };
export type ProjectListComparisonRow = {
  ordinal: number;
  state: RowState;
  projects: DisplayEntry[];
  chiefOfStaff: DisplayEntry[];
};
export interface ProjectListComparisonResult {
  schemaVersion: 1;
  status: CoverageStatus;
  observedAt: string;
  truncated: boolean;
  coverage: {
    projects: { status: CoverageStatus; scope: 'project-kind' };
    chiefOfStaff: { status: CoverageStatus; scope: 'confirmed-open-bindings' };
  };
  rows: ProjectListComparisonRow[];
}

const TITLE_CODE_POINT_LIMIT = 160;

function displayTitle(title: string): DisplayTitle {
  let codePoints = 0;
  let end = 0;
  for (const point of title) {
    if (codePoints === TITLE_CODE_POINT_LIMIT) return { title: title.slice(0, end), titleTruncated: true };
    codePoints++;
    end += point.length;
  }
  return { title, titleTruncated: false };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function titleKey(title: string): string {
  return title.normalize('NFC').toLowerCase();
}

function compareItems(a: GroupItem, b: GroupItem): number {
  return compareText(titleKey(a.title), titleKey(b.title)) || compareText(a.id, b.id);
}

function indexed(snapshot: AuthorizedProjectListSnapshot | undefined): Map<string, AuthorizedProjectListItem> | undefined {
  if (!snapshot || (snapshot.coverage === 'partial' && snapshot.items.length === 0)) return undefined;
  const items = new Map(snapshot.items.map(item => [item.id, item]));
  // A reader that supplies two rows for one native ID cannot prove unique current identity.
  return items.size === snapshot.items.length ? items : undefined;
}

function classify(input: ProjectListComparisonInput, projects: Map<string, AuthorizedProjectListItem> | undefined,
  chiefOfStaff: Map<string, AuthorizedProjectListItem> | undefined): Group[] {
  const verified = new Map<string, GroupItem[]>();
  const unresolved = new Set<string>();
  let unknownTarget = false;
  const staffItems = new Map<string, GroupItem>();
  for (const item of chiefOfStaff?.values() ?? []) {
    const display = { id: item.id, ...displayTitle(item.title) };
    staffItems.set(item.id, display);
    const relation = item.relation;
    if (!relation) unknownTarget = true;
    else if (relation.state === 'unresolved') unresolved.add(relation.targetId);
    else if (relation.state === 'verified') {
      const claims = verified.get(relation.targetId) ?? [];
      claims.push(display);
      verified.set(relation.targetId, claims);
    }
  }

  const groups: Group[] = [];
  const pairedStaff = new Set<string>();
  const completeRelations = !!projects && !!chiefOfStaff
    && input.projects?.relationsComplete === true && input.chiefOfStaff?.relationsComplete === true;
  const completeMembership = completeRelations
    && input.projects?.coverage === 'complete' && input.chiefOfStaff?.coverage === 'complete';
  for (const item of projects?.values() ?? []) {
    const display = { id: item.id, ...displayTitle(item.title) };
    const claims = verified.get(item.id) ?? [];
    const exclusive = completeRelations && !unknownTarget && !unresolved.has(item.id);
    if (claims.length >= 2 || (claims.length === 1 && exclusive)) {
      const state = claims.length >= 2 ? 'conflict' : 'matched';
      groups.push({ state, projects: [display], chiefOfStaff: claims.sort(compareItems) });
      for (const claim of claims) pairedStaff.add(claim.id);
    } else {
      const state = claims.length === 0 && exclusive && completeMembership ? 'projects-only' : 'counterpart-unchecked';
      groups.push({ state, projects: [display], chiefOfStaff: [] });
    }
  }
  for (const item of chiefOfStaff?.values() ?? []) {
    if (pairedStaff.has(item.id)) continue;
    const state = completeMembership && item.relation?.state === 'none' ? 'chief-of-staff-only' : 'counterpart-unchecked';
    groups.push({ state, projects: [], chiefOfStaff: [staffItems.get(item.id)!] });
  }

  const selected = groups.filter(group => input.view === 'all' || (input.view === 'matches') === (group.state === 'matched'));
  return selected.sort((a, b) => {
    const firstA = a.projects[0] ?? a.chiefOfStaff[0];
    const firstB = b.projects[0] ?? b.chiefOfStaff[0];
    return compareItems(firstA, firstB) || a.projects.length - b.projects.length;
  });
}

function publicRow(group: Group, ordinal: number, firstEntryOrdinal: number): ProjectListComparisonRow {
  let entryOrdinal = firstEntryOrdinal;
  const project = ({ title, titleTruncated }: GroupItem): DisplayEntry => ({
    ordinal: entryOrdinal++, title, titleTruncated,
  });
  return {
    ordinal, state: group.state,
    projects: group.projects.map(project),
    chiefOfStaff: group.chiefOfStaff.map(project),
  };
}

/** Group atomically, skip oversized groups and never serialize source IDs or claims. */
export function compareProjectLists(input: ProjectListComparisonInput): ProjectListComparisonResult {
  if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 0
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new RangeError('Invalid project comparison envelope');
  }
  const projects = indexed(input.projects);
  const chiefOfStaff = indexed(input.chiefOfStaff);
  const coverage: ProjectListComparisonResult['coverage'] = {
    projects: { status: projects ? input.projects!.coverage : 'unavailable', scope: 'project-kind' },
    chiefOfStaff: { status: chiefOfStaff ? input.chiefOfStaff!.coverage : 'unavailable', scope: 'confirmed-open-bindings' },
  };
  const usable = coverage.projects.status === 'complete' || coverage.chiefOfStaff.status === 'complete'
    || !!projects?.size || !!chiefOfStaff?.size;
  const complete = coverage.projects.status === 'complete' && coverage.chiefOfStaff.status === 'complete';
  const result: ProjectListComparisonResult = {
    schemaVersion: 1, status: !usable ? 'unavailable' : complete ? 'complete' : 'partial',
    observedAt: input.observedAt, truncated: false, coverage, rows: [],
  };
  const minimalBytes = Buffer.byteLength(JSON.stringify(result));
  const groups = usable ? classify(input, projects, chiefOfStaff) : [];
  if (groups.length === 0) {
    if (minimalBytes > input.maxBytes) throw new RangeError('Project comparison envelope cannot fit its metadata');
    return result;
  }
  let nextEntryOrdinal = 1;
  if (minimalBytes <= input.maxBytes && groups.length <= input.maxRows) {
    let bytes = minimalBytes;
    for (const group of groups) {
      const row = publicRow(group, result.rows.length + 1, nextEntryOrdinal);
      bytes += Buffer.byteLength(JSON.stringify(row)) + Number(result.rows.length > 0);
      if (bytes > input.maxBytes) break;
      result.rows.push(row);
      nextEntryOrdinal += row.projects.length + row.chiefOfStaff.length;
    }
    if (result.rows.length === groups.length) return result;
  }

  // Size the limited response with its actual status and truncation metadata.
  // Compute ordinals only for accepted groups so skipped groups leave no gaps.
  result.status = 'partial';
  result.truncated = true;
  result.rows = [];
  let bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > input.maxBytes) throw new RangeError('Project comparison envelope cannot fit its metadata');
  nextEntryOrdinal = 1;
  for (const group of groups) {
    if (result.rows.length === input.maxRows) break;
    const row = publicRow(group, result.rows.length + 1, nextEntryOrdinal);
    const increment = Buffer.byteLength(JSON.stringify(row)) + Number(result.rows.length > 0);
    if (bytes + increment > input.maxBytes) continue;
    bytes += increment;
    result.rows.push(row);
    nextEntryOrdinal += row.projects.length + row.chiefOfStaff.length;
  }
  // The truncated header is a little shorter. If it alone made all groups
  // fit, omit the last one so the response's truncation indicator stays true.
  if (result.rows.length === groups.length) result.rows.pop();
  return result;
}
