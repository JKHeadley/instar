// Console navigation model (docs/specs/console-makeover.md §2).
// Every legacy tab id appears exactly once; the unit test checks this list
// against the legacy TAB_REGISTRY so a new legacy tab can never go missing.

export const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  work: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  capacity: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2A5 5 0 0 1 21 19"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  server: '<rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  heart: '<path d="M20.8 6.6a5 5 0 0 0-8.8-2.3 5 5 0 0 0-8.8 2.3c0 5.4 8.8 11.4 8.8 11.4s8.8-6 8.8-11.4z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  coins: '<circle cx="9" cy="9" r="6"/><path d="M15.5 9.3A6 6 0 1 1 9.3 15.5"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M16 13h2M3 10h18"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  stamp: '<path d="M5 21h14M7 17h10l1-4H6l1 4zM12 13V8a3 3 0 1 0-3-3"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  toggle: '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="16" cy="12" r="3"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
};

export const GROUPS = [
  {
    id: 'work', label: 'Work', icon: 'work',
    question: 'What is being done, and what was promised?',
    tabs: [
      { id: 'sessions', label: 'Sessions', icon: 'terminal', desc: 'What is running on every machine, which one has gone quiet, and a live terminal you can watch and type into.' },
      // Shown only when GET /mobile/browser-devices/status answers 200 (the switch is on): the probe.
      { id: 'chats', label: 'Conversations', icon: 'chat', desc: 'Your app conversations, Telegram topics and Slack conversations, like the iPhone app: read, send, photos and files.', probe: '/mobile/browser-devices/status' },
      // Shown only when GET /docs/health answers 200 (documents are switched on): the probe.
      { id: 'documents', label: 'Documents', icon: 'folder', desc: 'Longer writing people comment on: open comments first, each opening on its own page.', probe: '/docs/health' },
      { id: 'jobs', label: 'Schedule', icon: 'clock', desc: 'What runs on its own, and whether it actually ran: late, failing and running-long jobs first.' },
      { id: 'commitments', label: 'Promises', icon: 'check', desc: 'Every promise I made, what it is waiting on, and whether it was kept.' },
      { id: 'projects', label: 'Plans', icon: 'layers', desc: 'Longer work and multi-round plans: how each is going, what needs your OK, and what is in the way.' },
    ],
  },
  {
    id: 'capacity', label: 'Capacity', icon: 'capacity',
    question: 'What do I run on, and what does it cost?',
    tabs: [
      { id: 'machines', label: 'Machines', icon: 'server', desc: 'Each machine’s health, which one leads, and how they reach each other.' },
      { id: 'systems', label: 'Health', icon: 'heart', desc: 'Whether each of my subsystems is working.' },
      { id: 'subscriptions', label: 'Accounts', icon: 'key', desc: 'Subscriptions and sign-ins: usage left before reset, and fixing a sign-in from your phone.' },
      { id: 'resources', label: 'Resource usage', icon: 'cpu', desc: 'CPU and memory for the server and every session.' },
      { id: 'spend', label: 'What thinking costs', icon: 'wallet', desc: 'Recorded AI cost on this machine: pay-per-use by model, background checks, what your conversations process, and the spending limits.' },
    ],
  },
  {
    id: 'people', label: 'People', icon: 'people',
    question: 'Who is talking to whom, and with what permission?',
    tabs: [
      { id: 'reach', label: 'Who can reach me', icon: 'people', desc: 'Everyone who can reach this agent, how, and what each person can see.' },
      { id: 'threadline', label: 'Other agents', icon: 'chat', desc: 'Who is waiting on you, whether each agent I work with is actually there, pairing new ones, and our conversations.' },
      { id: 'notifications', label: 'Notifications', icon: 'chat', desc: 'Quiet reports and the categories you want pushed to you.' },
      { id: 'origins', label: 'Messages to you', icon: 'chat', desc: 'Who wrote each message I sent you, and the who-wrote-this footer.' },
      { id: 'mandates', label: 'Permission slips', icon: 'stamp', desc: 'What you have let agents do together, who is waiting for your approval, and every allow and refusal.' },
      { id: 'phones', label: 'Phones', icon: 'phone', desc: 'Pair the Instar iPhone app: approve a waiting phone, or read its code, after your PIN (when there is no Telegram), and the phones already paired.' },
      { id: 'secrets', label: 'Passwords & keys', icon: 'lock', desc: 'Whether the agent is waiting on a password, a safe one-time link to hand one over, and the keys it already holds.' },
    ],
  },
  {
    id: 'settings', label: 'Settings', icon: 'settings',
    question: 'How is it set up, and what has it learned?',
    tabs: [
      { id: 'features', label: 'What I’m allowed to do', icon: 'toggle', desc: 'How independent I am, the safety checks, and which features are on.' },
      { id: 'preferences-learning', label: 'What I’ve learned about you', icon: 'sparkle', desc: 'How you like things, picked up from your corrections, and the corrections I am still watching.' },
      { id: 'files', label: 'Files', icon: 'folder', desc: 'Find, read and fix a project file from your phone, and choose which folders can be browsed and edited.' },
    ],
    hood: [
      { id: 'insights', label: 'Insights', desc: 'A plain-language read of what stands out.' },
      { id: 'integrated-being', label: 'How I’m doing inside', desc: 'Conversation history, recurring problems, checks on my claims.' },
    ],
  },
];

/**
 * Legacy tabs whose content now lives inside another console page. They get
 * no tile of their own (a tile that only says "now inside X" is clutter);
 * their old links still land on the page that holds them (NATIVE_PAGES).
 */
export const MERGED = ['dropzone', 'initiatives', 'blockers', 'tokens', 'pr-pipeline', 'evidence', 'routing-map', 'llm-activity', 'throughput', 'process-health', 'feedback-drain'];

/** Every legacy tab id the console links to, including the merged ones. */
export function allTabIds() {
  return [...GROUPS.flatMap((g) => [...g.tabs, ...(g.hood || [])].map((t) => t.id)), ...MERGED];
}

/** Features rebuilt natively in the console, by legacy tab id. */
/** Tiles with no legacy dashboard tab: new pages are built in the console only. */
export const CONSOLE_ONLY_TABS = ['reach', 'chats', 'documents'];

export const NATIVE_PAGES = {
  commitments: '#/work/promises',
  jobs: '#/work/schedule',
  sessions: '#/work/sessions',
  chats: '#/work/chats',
  documents: '#/work/documents',
  // Sending text or files now happens in each session's own message box.
  dropzone: '#/work/sessions',
  projects: '#/work/plans',
  initiatives: '#/work/plans',
  blockers: '#/work/plans?s=in-the-way',
  machines: '#/capacity/machines',
  systems: '#/capacity/health',
  subscriptions: '#/capacity/accounts',
  spend: '#/capacity/costs',
  tokens: '#/capacity/costs',
  'llm-activity': '#/capacity/costs',
  'routing-map': '#/capacity/costs',
  reach: '#/people/reach',
  origins: '#/people/messages',
  notifications: '#/people/notifications',
  threadline: '#/people/agents',
  mandates: '#/people/mandates',
  secrets: '#/people/secrets',
  features: '#/settings/allowed',
  'preferences-learning': '#/settings/learned',
  files: '#/settings/files',
  // The pairing code page: its own strict page, outside the console (PIN, then the code + Copy).
  phones: '/dashboard/pair',
  'pr-pipeline': '#/work/development?s=shipping',
  throughput: '#/work/development?s=pace',
  'feedback-drain': '#/work/development?s=feedback',
  'integrated-being': '#/settings/inside',
  'process-health': '#/settings/inside?s=problems',
  evidence: '#/settings/inside?s=lookup',
};

/** Where a tile goes: the native page when it exists, else the legacy tab. */
export function tabHref(tabId) {
  return NATIVE_PAGES[tabId] || legacyHref(tabId);
}

/** The legacy dashboard's own address (/dashboard itself opens this console). */
export const LEGACY_DASHBOARD = '/dashboard/legacy';

/** The legacy URL for a tab. Ordinary link; nothing is embedded. */
export function legacyHref(tabId) {
  return `${LEGACY_DASHBOARD}?tab=${encodeURIComponent(tabId)}`;
}

export function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ── Phone mode (the Instar iPhone app) ────────────────────────────────────
// The app shows one console page inside its own frame:
//   /dashboard/console/?phone=1#/<page>   (or #/<page>?phone=1)
// shows only that page's content, with no top bar, nav or Legacy link.
// Without phone=1 nothing changes.

/** Short page names the app may use, by the console's own hash path. */
export const PHONE_PAGE_ALIASES = {
  promises: 'work/promises',
  plans: 'work/plans',
  schedule: 'work/schedule',
  development: 'work/development',
  maturation: 'work/maturation',
  ideas: 'work/ideas',
  sessions: 'work/sessions',
  chats: 'work/chats',
  documents: 'work/documents',
  pace: 'work/pace',
  machines: 'capacity/machines',
  health: 'capacity/health',
  accounts: 'capacity/accounts',
  costs: 'capacity/costs',
  reach: 'people/reach',
  messages: 'people/messages',
  agents: 'people/agents',
  mandates: 'people/mandates',
  secrets: 'people/secrets',
  allowed: 'settings/allowed',
  learned: 'settings/learned',
  inside: 'settings/inside',
  files: 'settings/files',
};

/** Pages that exist only in phone mode (the Pace card is a page of its own there). */
export const PHONE_ONLY_PAGES = ['work/pace'];

function queryHasPhone(query) {
  if (typeof query !== 'string' || !query) return false;
  try { return new URLSearchParams(query.replace(/^\?/, '')).get('phone') === '1'; } catch { return false; }
}

/**
 * Is this load in phone mode? True when phone=1 is in the page's query
 * (location.search) or in the hash's own query (#/accounts?phone=1).
 */
export function isPhoneMode(search, hash) {
  if (queryHasPhone(search)) return true;
  const h = typeof hash === 'string' ? hash : '';
  const q = h.indexOf('?');
  return q >= 0 && queryHasPhone(h.slice(q + 1));
}

/** The page path to render: in phone mode a short name resolves to its full path. */
export function pagePath(path, phone) {
  if (!phone) return path;
  return Object.prototype.hasOwnProperty.call(PHONE_PAGE_ALIASES, path) ? PHONE_PAGE_ALIASES[path] : path;
}
