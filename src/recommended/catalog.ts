/**
 * The recommended outside services (docs/specs/recommended-services.md, The catalog).
 *
 * Every row says what a person needs to decide: the benefit, what leaves the machine and to whom,
 * the cost, the account, and what they keep if they say no. Prices quote no numbers, because a
 * provider can change them. A setup recipe confirms the price before asking for a yes.
 *
 * Backup status is an honest record, proven by tests/unit/recommended-services-catalog.test.ts:
 * `gap` must name its spec, and `exercised` must name a drill that exists.
 */
import crypto from 'node:crypto';

export const BACKUP_STATUSES = ['exercised', 'specified', 'gap'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export interface CatalogRow {
  id: string;
  name: string;
  benefit: string;
  dataLeaves: string;
  cost: string;
  account: string;
  /** What the agent falls back on. Null only on a `gap` row, where nothing exists yet. */
  backup: string | null;
  backupStatus: BackupStatus;
  /** When a gap applies, if not always. */
  gapWhen?: string;
  /** The spec that closes a `gap`. Required on a `gap` row. */
  gapSpec?: string;
  /** The test that proved the fallback. Required on an `exercised` row. */
  drillTest?: string;
  /** The id of a live-proven setup recipe. A service with none is unavailable, so a yes can't be taken for it. */
  setupRecipe: string | null;
  /** A way for the person to reach the agent (an address or a channel). Switching one off waits until another route works. */
  wayIn?: boolean;
}

const LOCAL_MODEL_SPEC = 'docs/specs/backup-local-model-last-resort.md';
const OFF_MACHINE_SPEC = 'docs/specs/backup-off-machine-copy.md';
const VOICE_SPEC = 'docs/specs/backup-on-machine-voice.md';

export const RECOMMENDED_SERVICE_CATALOG: readonly CatalogRow[] = Object.freeze([
  {
    id: 'tailscale',
    wayIn: true,
    name: 'Tailscale',
    benefit: 'A private address for reaching your agent from your own devices, and the strongest link between its machines.',
    dataLeaves: 'Device names and network addresses go to Tailscale so your devices can find each other. Your traffic stays encrypted between them.',
    cost: 'Free on the Personal plan, which is meant for non-commercial use.',
    account: 'A Tailscale account, signed in with an existing Google, GitHub or similar login.',
    backup: 'Cloudflare, your local network, or messaging, which needs no address.',
    backupStatus: 'specified',
    // Proven live 2026-11-07 (topic 135786): a test agent sent the sign-in link, the person's tap signed the machine in, the check passed.
    setupRecipe: 'tailscale-v1',
  },
  {
    id: 'cloudflare-domain',
    wayIn: true,
    name: 'Cloudflare with your own domain',
    benefit: 'A public address that never changes. Saying no keeps the temporary address, so tunnels stay on.',
    dataLeaves: 'Every request to your agent passes through Cloudflare.',
    cost: 'The domain has a yearly fee. I confirm the price with you before buying anything.',
    account: 'A Cloudflare account and a domain.',
    backup: 'Tailscale, your local network, the optional relay, or a temporary relay you agree to.',
    backupStatus: 'specified',
    setupRecipe: null,
  },
  {
    id: 'telegram',
    wayIn: true,
    name: 'Telegram',
    benefit: 'Reach your agent from anywhere, and get its messages on your phone.',
    dataLeaves: 'Your messages with your agent pass through Telegram.',
    cost: 'Free.',
    account: 'A Telegram account, which needs a phone number, plus a bot I set up.',
    backup: 'Slack, WhatsApp, iMessage, the Instar app, or the dashboard.',
    backupStatus: 'specified',
    setupRecipe: null,
  },
  {
    id: 'jev',
    name: 'Jev (TypeSafe)',
    benefit: 'Optional efficiency upgrade: your agent runs without it. Could bring large efficiency gains, by answering routine yes-or-no judgments quickly and cheaply, and adds another opinion on advisory checks. Not measured yet. The gains arrive as each feature using it is proven, not all at once.',
    dataLeaves: 'Short pieces of text from those checks go to TypeSafe, with secrets removed first.',
    cost: 'Paid by use, at a very small cost per call. TypeSafe needs credits added before it gives out a key, so this needs a card or a credit code. I confirm the price and amount with you first.',
    account: 'A TypeSafe account and key, which I get myself.',
    backup: 'Those checks skip it or use their normal path.',
    backupStatus: 'specified',
    // Proven live 2026-11-05 (topic 135786): a test agent opened the account, got the key and stored it; the check passed.
    setupRecipe: 'jev-v1',
  },
  {
    id: 'bitwarden',
    name: 'Bitwarden',
    benefit: 'Your agent’s passwords and keys survive losing a machine.',
    dataLeaves: 'Your agent’s own secrets, encrypted before they leave. Bitwarden can’t read them.',
    cost: 'Free plan available.',
    account: 'A Bitwarden account. I only use a folder of my own in it.',
    backup: 'The local encrypted store, and secret sync between machines if you have more than one.',
    backupStatus: 'gap',
    gapWhen: 'On a single machine, losing that machine loses the secrets.',
    gapSpec: OFF_MACHINE_SPEC,
    // Proven live 2026-11-07 (topic 135786): a test agent took the person's yes, received the login through Secret Drop, had the server write the copy, and its check passed.
    setupRecipe: 'bitwarden-v1',
  },
  {
    id: 'github-state-backup',
    name: 'GitHub private backup',
    benefit: 'A copy of your agent’s memory and settings off this machine.',
    dataLeaves: 'Your agent’s memory, settings and identity files go to a private repository on GitHub.',
    cost: 'Free for a private repository.',
    account: 'A GitHub account, yours or one I create.',
    backup: 'Snapshots on the same machine, which don’t survive losing it.',
    backupStatus: 'gap',
    gapWhen: 'Nothing else keeps a copy off the machine.',
    gapSpec: OFF_MACHINE_SPEC,
    setupRecipe: 'github-v1',
  },
  {
    id: 'second-ai-door',
    name: 'A second AI subscription',
    benefit: 'A second AI provider your agent can work on: when the main one is down or out of quota, you can ask it to move a conversation over, so the work doesn’t stop.',
    dataLeaves: 'Your agent’s conversations and work go to that provider when it’s in use.',
    cost: 'A paid subscription. I confirm the price with you before anything is bought.',
    account: 'An account with the second provider.',
    backup: 'Any other AI door you have enabled.',
    backupStatus: 'gap',
    gapWhen: 'With only one door, your agent stops when that provider does.',
    gapSpec: LOCAL_MODEL_SPEC,
    setupRecipe: 'second-door-v1',
  },
  {
    id: 'voice-transcription',
    name: 'Voice transcription (Groq or OpenAI)',
    benefit: 'Your agent understands voice notes.',
    dataLeaves: 'The audio of your voice notes goes to the provider.',
    cost: 'Groq has a limited free tier, and OpenAI charges by the minute. I confirm the price with you first.',
    account: 'An account and key with Groq or OpenAI, which I get myself.',
    backup: 'Your agent says it can’t read the voice note.',
    backupStatus: 'gap',
    gapWhen: 'Nothing can read a voice note without a provider.',
    gapSpec: VOICE_SPEC,
    setupRecipe: 'voice-v1',
  },
  {
    id: 'email',
    name: 'Email',
    benefit: 'Reports you choose arrive in your inbox. I only ever email you, at the address you type here.',
    dataLeaves: 'Those reports go through the email service you pick: Resend, or your own Gmail or iCloud.',
    cost: 'Free: Resend’s free plan, or the mailbox you already have.',
    account: 'Your choice: a free Resend account I open in your name, your own Gmail or iCloud, or a mailbox you give me.',
    backup: 'The report comes to our conversation instead, with a line saying why.',
    backupStatus: 'exercised',
    drillTest: 'tests/e2e/email-sending-lifecycle.test.ts',
    // Proving: available only to an agent that lists email-v1 under recommendedServices.provingRecipes until its live proof.
    setupRecipe: null,
  },
] satisfies CatalogRow[]);

/** Deterministic: a service with no live-proven recipe is unavailable. */
export function isServiceAvailable(row: CatalogRow): boolean {
  return row.setupRecipe !== null;
}

/** What the person read. A yes is bound to it, so changed text needs a fresh look. */
export function offerTextHash(row: CatalogRow): string {
  const { name, benefit, dataLeaves, cost, account, backup } = row;
  return crypto.createHash('sha256').update(JSON.stringify({ name, benefit, dataLeaves, cost, account, backup })).digest('hex');
}
