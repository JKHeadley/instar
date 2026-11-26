import { encodeNodeRef } from './conversations-model.js';
import { el } from './ui.js';

const COLLAPSED_KEY = 'instar.conversations.tree.collapsed';
const SORT_KEY = 'instar.conversations.tree.sort';
const MAX_TREE_NODES = 400;
const MAX_RENDER_DEPTH = 12;

export function conversationRefKey(ref) {
  if (ref?.kind !== 'conversation') return null;
  if (ref.platform === 'app') return `app:${ref.conversationKey}`;
  if (ref.platform === 'telegram') return `telegram:${ref.topicId}`;
  if (ref.platform === 'slack') return `slack:${ref.channelId}${ref.threadTs ? `:${ref.threadTs}` : ''}`;
  return null;
}

export function treePage(data) {
  if (!data || (!data.sections && !Array.isArray(data.items)) || typeof data.partial !== 'boolean') return null;
  let remaining = MAX_TREE_NODES + 1; // The Chief row can sit outside the page's node budget.
  function node(raw, depth) {
    const key = encodeNodeRef(raw?.ref);
    if (!key || depth > MAX_RENDER_DEPTH || --remaining < 0 || raw.kind !== raw.ref.kind ||
        typeof raw.title !== 'string' || !raw.title.trim()) throw new Error('Invalid conversation tree');
    const readChildren = (field) => {
      if (raw[field] === undefined) return [];
      if (!Array.isArray(raw[field])) throw new Error('Invalid conversation tree children');
      return raw[field].map(child => node(child, depth + 1));
    };
    const children = readChildren('children');
    const proposed = readChildren('proposed');
    return {
      key, ref: raw.ref, kind: raw.kind, role: raw.role, title: raw.title, frontDoor: raw.frontDoor,
      freshness: raw.sourceFreshness || null,
      project: typeof raw.project?.conversationKey === 'string' && typeof raw.project.title === 'string' ? raw.project : null,
      projectKey: typeof raw.projectConversationKey === 'string' ? raw.projectConversationKey : raw.project?.conversationKey,
      count: Number.isSafeInteger(raw.visibleChildCount) && raw.visibleChildCount >= 0 ? raw.visibleChildCount : null,
      incomplete: raw.childrenComplete === false || raw.proposedComplete === false,
      children, proposed,
    };
  }
  try {
    const root = data.root ? node(data.root, 0) : null;
    const sections = data.sections === undefined ? null : Object.fromEntries(
      ['projects', 'groups', 'ungrouped'].map(name => {
        if (!Array.isArray(data.sections?.[name])) throw new Error('Invalid conversation tree section');
        return [name, data.sections[name].map(item => node(item, 0))];
      }));
    const items = sections ? [] : data.items.map(item => node(item, 0));
    if (root && root.kind !== 'conversation') return null;
    return { root, items, sections, partial: data.partial, projectsKnown: data.projects === 'known',
      placementComplete: data.placementComplete === true, canCorrect: data.capabilities?.ownerCorrections === true,
      nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null };
  } catch { return null; }
}

export function hasAuthoritativeSections(page) {
  return page?.placementComplete === true && Boolean(page.sections);
}

function timestamp(value) {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0;
}

export function compareConversationActivity(sort) {
  return (a, b) => sort === 'name' ? a.title.localeCompare(b.title)
    : timestamp(b.freshness ?? b.lastActivity ?? b.sourceFreshness) - timestamp(a.freshness ?? a.lastActivity ?? a.sourceFreshness);
}

export function conversationTreePreferences() {
  let collapsed = new Set();
  let sort = 'newest';
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    if (Array.isArray(saved)) collapsed = new Set(saved.filter(key => typeof key === 'string').slice(-400));
    if (localStorage.getItem(SORT_KEY) === 'name') sort = 'name';
  } catch { /* unavailable storage keeps this page's choices */ }
  return {
    collapsed,
    get sort() { return sort; },
    saveExpanded(key, expanded) {
      if (expanded) collapsed.delete(key);
      else collapsed.add(key);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed].slice(-400))); } catch { /* page-local */ }
    },
    sortControl(update) {
      const select = el('select', { class: 'reason-input', 'aria-label': 'Sort conversations' },
        el('option', { value: 'newest', text: 'Newest message first' }),
        el('option', { value: 'name', text: 'Name' }));
      select.value = sort;
      select.addEventListener('change', () => {
        sort = select.value === 'name' ? 'name' : 'newest';
        try { localStorage.setItem(SORT_KEY, sort); } catch { /* page-local */ }
        update();
      });
      return select;
    },
  };
}

/** Draw only the placement the owner projection supplied. No flat row becomes Ungrouped by omission. */
export function renderOwnerTree(pages, { preferences, conversationRow, groupDetails }) {
  const root = pages[0]?.root;
  const roots = pages.flatMap(page => page.items);
  const seen = new Set(root ? [root.key] : []);
  const compare = compareConversationActivity(preferences.sort);
  const sorted = (nodes) => [...nodes].sort(compare);
  function disclosure(key, label, children, cls = '') {
    const details = el('details', { class: `conversation-tree-disclosure ${cls}`.trim() },
      el('summary', { class: 'chat-effort-row', text: label }), children);
    details.open = !preferences.collapsed.has(key);
    details.addEventListener('toggle', () => preferences.saveExpanded(key, details.open));
    return details;
  }
  function branch(n) {
    if (seen.has(n.key)) return null;
    seen.add(n.key);
    const children = sorted(n.children).map(branch).filter(Boolean);
    // Proposed card placement is rendered only inside the server-chosen branch.
    const proposed = sorted(n.proposed).map(branch).filter(Boolean);
    if (n.kind === 'conversation') {
      const row = conversationRow(n);
      if (n.project && n.projectKey === conversationRefKey(n.ref)) {
        // A confirmed project can use its own conversation as the branch
        // identity even when no saved effort exists.
        const count = n.count === null ? '' : ` · ${n.count + 1}`;
        return disclosure(`project:${n.projectKey}`, `${n.project.title}${count}`,
          [row, children, proposed, n.incomplete ? groupDetails(n) : null], 'chat-project-row');
      }
      return children.length || proposed.length || n.incomplete
        ? el('div', { class: 'conversation-tree-conversation' }, row,
          disclosure(`children:${n.key}`, 'Related conversations', [children, proposed, n.incomplete ? groupDetails(n) : null]))
        : row;
    }
    const count = n.count === null ? '' : ` · ${n.count}`;
    return disclosure(n.projectKey ? `project:${n.projectKey}` : n.key, `${n.project?.title || n.title}${count}`,
      [children, proposed, n.incomplete ? groupDetails(n) : null], n.project ? 'chat-project-row' : '');
  }
  const output = [];
  if (root) output.push(el('div', { class: 'conversation-tree-chief' }, conversationRow(root, true)));
  const hasSections = pages.every(page => page.sections);
  const sectionItems = (name) => pages.flatMap(page => page.sections?.[name] || []);
  const projectRoots = hasSections ? sectionItems('projects') : roots.filter(n => n.kind === 'effort' && n.project);
  const groupRoots = hasSections ? sectionItems('groups') : roots.filter(n => n.kind === 'effort' && !n.project);
  const ungrouped = hasSections ? sectionItems('ungrouped').filter(node => !node.projectKey) : [];
  for (const [name, rows] of [['Projects', projectRoots], ['Groups', groupRoots], ['Ungrouped', ungrouped]]) {
    const children = sorted(rows).map(branch).filter(Boolean);
    if (children.length) output.push(disclosure(`section:${name}`, name, children, 'conversation-tree-section'));
  }
  if (pages.some(page => page.partial || !page.projectsKnown || !page.placementComplete)) {
    output.push(el('p', { class: 'card-note', role: 'status', text: 'Some conversation placements could not be checked.' }));
  }
  return output;
}
