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
      { id: 'sessions', label: 'Sessions', icon: 'terminal', desc: 'Live sessions on every machine, with a terminal you can watch and type into.' },
      { id: 'jobs', label: 'Jobs', icon: 'clock', desc: 'Scheduled work: what runs when, and what happened last time.' },
      { id: 'commitments', label: 'Promises', icon: 'check', desc: 'Every promise I made, what it is waiting on, and whether it was kept.' },
      { id: 'projects', label: 'Plans', icon: 'layers', desc: 'Longer work and multi-round plans: how each is going, what needs your OK, and what is in the way.' },
      { id: 'initiatives', label: 'Initiatives', icon: 'flag', desc: 'Now inside Plans: longer efforts in flight, and the items that need you.' },
      { id: 'blockers', label: 'Blockers', icon: 'alert', desc: 'Now inside Plans, under “In the way”: what looked stuck, and how sure that still is.' },
      { id: 'dropzone', label: 'Send content', icon: 'send', desc: 'Paste text or files straight into a session.' },
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
      { id: 'tokens', label: 'Tokens', icon: 'coins', desc: 'Token use across sessions in the last day.' },
      { id: 'spend', label: 'Spend', icon: 'wallet', desc: 'What background AI calls cost, and the spending limits.' },
    ],
  },
  {
    id: 'people', label: 'People', icon: 'people',
    question: 'Who is talking to whom, and with what permission?',
    tabs: [
      { id: 'threadline', label: 'Threadline', icon: 'chat', desc: 'Conversations with other agents, and pairing new ones.' },
      { id: 'origins', label: 'Messages to you', icon: 'chat', desc: 'Replies held back from you, and the who-wrote-this footer.' },
      { id: 'mandates', label: 'Mandates', icon: 'stamp', desc: 'Permission slips you signed for agent-to-agent work.' },
      { id: 'secrets', label: 'Secrets', icon: 'lock', desc: 'One-time links for handing over passwords and keys safely.' },
    ],
  },
  {
    id: 'settings', label: 'Settings', icon: 'settings',
    question: 'How is it set up, and what has it learned?',
    tabs: [
      { id: 'features', label: 'What I’m allowed to do', icon: 'toggle', desc: 'How independent I am, the safety checks, and which features are on.' },
      { id: 'preferences-learning', label: 'Preferences', icon: 'sparkle', desc: 'What I have learned from your corrections.' },
      { id: 'files', label: 'Files', icon: 'folder', desc: 'Browse and edit project files.' },
    ],
    hood: [
      { id: 'insights', label: 'Insights', desc: 'A plain-language read of what stands out.' },
      { id: 'pr-pipeline', label: 'PR pipeline', desc: 'Pull requests moving through review to merge.' },
      { id: 'evidence', label: 'Evidence', desc: 'The sources behind a memory.' },
      { id: 'routing-map', label: 'Routing map', desc: 'Which model each background job uses.' },
      { id: 'llm-activity', label: 'LLM activity', desc: 'How often each automated AI check acted.' },
      { id: 'throughput', label: 'Throughput', desc: 'Delivery and quality over time.' },
      { id: 'integrated-being', label: 'Integrated-Being', desc: 'What other parts of me have been doing.' },
      { id: 'process-health', label: 'Process health', desc: 'Failures caught and patterns found.' },
      { id: 'feedback-drain', label: 'Feedback drain', desc: 'User feedback being turned into fixes.' },
    ],
  },
];

/** Every legacy tab id the console links to. */
export function allTabIds() {
  return GROUPS.flatMap((g) => [...g.tabs, ...(g.hood || [])].map((t) => t.id));
}

/** Features rebuilt natively in the console, by legacy tab id. */
export const NATIVE_PAGES = {
  commitments: '#/work/promises',
  projects: '#/work/plans',
  initiatives: '#/work/plans',
  blockers: '#/work/plans?s=in-the-way',
  machines: '#/capacity/machines',
  subscriptions: '#/capacity/accounts',
  origins: '#/people/messages',
  features: '#/settings/allowed',
};

/** Where a tile goes: the native page when it exists, else the legacy tab. */
export function tabHref(tabId) {
  return NATIVE_PAGES[tabId] || legacyHref(tabId);
}

/** The legacy URL for a tab. Ordinary link; nothing is embedded. */
export function legacyHref(tabId) {
  return `/dashboard?tab=${encodeURIComponent(tabId)}`;
}

export function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
