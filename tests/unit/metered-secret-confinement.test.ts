/**
 * gemini-payg-metered-lane §4 — metered (pay-per-use) key confinement.
 *
 * Covers: the single list (meteredSecrets.ts), per-recipient sync filtering with the
 * no-designation drop-all, the receive-side strip, whole-vault consumers emitting names
 * or ciphertext only, the secret-get top-of-script refusal in every branch plus its
 * template-drift pin, the named-reader lint, and the value-based child-env canary
 * across the five frameworks' env builders.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  METERED_SECRET_NAMES,
  METERED_SECRET_PREFIX,
  GEMINI_PAYG_SECRET_NAME,
  isMeteredSecretName,
  meteredSendAllowed,
  meteredReceiveAllowed,
} from '../../src/core/meteredSecrets.js';
import {
  filterSecretsForSync,
  SecretProvisioner,
  SecretShareHandler,
  buildSecretShareCommand,
  secretKeyPaths,
  type SecretShareCommand,
} from '../../src/core/SecretSync.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildGeminiChildEnv } from '../../src/providers/adapters/gemini-cli/transport/geminiSpawn.js';
import { buildPiChildEnv } from '../../src/providers/adapters/pi-cli/transport/piSpawn.js';
import { buildGrokChildEnv } from '../../src/providers/adapters/grok-build/transport/grokSpawn.js';
import { buildCodexChildEnv } from '../../src/providers/adapters/openai-codex/transport/codexSpawn.js';
import { buildClaudeReviewerChildEnv } from '../../src/core/ClaudeCliIntelligenceProvider.js';

const KEY_VALUE = 'AIzaSy-METERED-CANARY-VALUE-0123456789abcdef';

function x25519() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    priv: privateKey,
  };
}

describe('meteredSecrets — the single list', () => {
  it('holds the payg key and every existing metered_* bench name', () => {
    expect(METERED_SECRET_NAMES).toContain(GEMINI_PAYG_SECRET_NAME);
    for (const n of ['metered_gemini_bench', 'metered_openrouter_bench', 'metered_groq_bench']) {
      expect(METERED_SECRET_NAMES).toContain(n);
    }
  });

  it('matches exact names and the reserved prefix, by first segment only', () => {
    expect(isMeteredSecretName('gemini_api_key_payg')).toBe(true);
    expect(isMeteredSecretName('metered_future_bench')).toBe(true);
    expect(isMeteredSecretName(`${METERED_SECRET_PREFIX}x.sub`)).toBe(true);
    expect(isMeteredSecretName('telegram.token')).toBe(false);
    expect(isMeteredSecretName('authToken')).toBe(false);
    expect(isMeteredSecretName('nested.metered_gemini_bench')).toBe(false);
    expect(isMeteredSecretName('')).toBe(false);
  });

  it('send/receive allowed only to the designated machine, fail-closed otherwise', () => {
    const d = { designatedMachineId: 'm_studio' };
    expect(meteredSendAllowed('m_studio', d)).toBe(true);
    expect(meteredSendAllowed('m_mamapc', d)).toBe(false);
    expect(meteredSendAllowed('m_studio', null)).toBe(false);
    expect(meteredSendAllowed('m_studio', { designatedMachineId: null })).toBe(false);
    expect(meteredSendAllowed('m_studio', { designatedMachineId: 'm_studio', transferPending: true })).toBe(false);
    expect(meteredSendAllowed(undefined, d)).toBe(false);
    expect(meteredReceiveAllowed('m_studio', d)).toBe(true);
    expect(meteredReceiveAllowed('m_mamapc', d)).toBe(false);
  });
});

describe('filterSecretsForSync — per-recipient metered routing (§4.6)', () => {
  const vault = {
    authToken: 'a',
    gemini_api_key_payg: KEY_VALUE,
    metered_gemini_bench: 'b',
    metered_groq_bench: 'g',
    telegram: { token: 't' },
  };

  it('drops every metered key with no options (no designation → drop for all)', () => {
    const out = filterSecretsForSync(vault);
    expect(Object.keys(out).sort()).toEqual(['authToken', 'telegram']);
  });

  it('drops metered keys for a non-designated recipient', () => {
    const out = filterSecretsForSync(vault, '', { recipientMachineId: 'm_mamapc', designation: { designatedMachineId: 'm_studio' } });
    expect(out).not.toHaveProperty('gemini_api_key_payg');
    expect(out).not.toHaveProperty('metered_gemini_bench');
    expect(out).toHaveProperty('authToken');
  });

  it('keeps metered keys only for the designated recipient', () => {
    const out = filterSecretsForSync(vault, '', { recipientMachineId: 'm_studio', designation: { designatedMachineId: 'm_studio' } });
    expect(out).toHaveProperty('gemini_api_key_payg', KEY_VALUE);
    expect(out).toHaveProperty('metered_groq_bench');
  });

  it('drops metered keys for ALL recipients while a transfer proposal exists', () => {
    const out = filterSecretsForSync(vault, '', { recipientMachineId: 'm_studio', designation: { designatedMachineId: 'm_studio', transferPending: true } });
    expect(out).not.toHaveProperty('gemini_api_key_payg');
  });

  it('does not treat a nested key named like a metered key as metered (root only)', () => {
    const out = filterSecretsForSync({ group: { metered_gemini_bench: 'x' } });
    expect(out).toEqual({ group: { metered_gemini_bench: 'x' } });
  });
});

describe('SecretProvisioner.provisionAll — filters INSIDE the per-peer loop', () => {
  it('sends the metered key to the designated peer only; others get the rest', async () => {
    const studio = x25519();
    const mama = x25519();
    const sent: Record<string, SecretShareCommand> = {};
    const p = new SecretProvisioner({
      secretsToSync: () => ({ authToken: 'a', gemini_api_key_payg: KEY_VALUE }),
      listPeers: () => [
        { machineId: 'm_studio', encryptionPublicKey: studio.pub },
        { machineId: 'm_mamapc', encryptionPublicKey: mama.pub },
      ],
      send: async (id, cmd) => { sent[id] = cmd; return { ok: true }; },
      meteredDesignation: () => ({ designatedMachineId: 'm_studio' }),
    });
    const res = await p.provisionAll();
    expect(res.map((r) => r.machineId).sort()).toEqual(['m_mamapc', 'm_studio']);
    const recvStudio = new SecretShareHandler({
      ownEncryptionPrivateKey: () => studio.priv,
      store: { set: () => {} },
      selfMachineId: () => 'm_studio',
      meteredDesignation: () => ({ designatedMachineId: 'm_studio' }),
    });
    const recvMama = new SecretShareHandler({
      ownEncryptionPrivateKey: () => mama.priv,
      store: { set: () => {} },
      selfMachineId: () => 'm_mamapc',
      meteredDesignation: () => ({ designatedMachineId: 'm_studio' }),
    });
    expect(recvStudio.handle(sent.m_studio, 'm_x').stored.sort()).toEqual(['authToken', 'gemini_api_key_payg']);
    expect(recvMama.handle(sent.m_mamapc, 'm_x').stored).toEqual(['authToken']);
    expect(recvMama.lastDroppedMetered).toBe(0); // never sent, so nothing to strip
  });

  it('with no designation source, no peer receives a metered key', async () => {
    const peer = x25519();
    let cmd: SecretShareCommand | null = null;
    const p = new SecretProvisioner({
      secretsToSync: () => ({ authToken: 'a', metered_gemini_bench: 'b' }),
      listPeers: () => [{ machineId: 'm_studio', encryptionPublicKey: peer.pub }],
      send: async (_id, c) => { cmd = c; return { ok: true }; },
    });
    await p.provisionAll();
    const stored: string[] = [];
    new SecretShareHandler({ ownEncryptionPrivateKey: () => peer.priv, store: { set: (k) => stored.push(k) } }).handle(cmd!, 'm_x');
    expect(stored).toEqual(['authToken']);
  });

  it('a peer whose filtered set is empty is skipped, not sent an empty batch', async () => {
    const peer = x25519();
    const sends: string[] = [];
    const p = new SecretProvisioner({
      secretsToSync: () => ({ gemini_api_key_payg: KEY_VALUE }),
      listPeers: () => [{ machineId: 'm_mamapc', encryptionPublicKey: peer.pub }],
      send: async (id) => { sends.push(id); return { ok: true }; },
      meteredDesignation: () => ({ designatedMachineId: 'm_studio' }),
    });
    expect(await p.provisionAll()).toEqual([]);
    expect(sends).toEqual([]);
  });
});

describe('SecretShareHandler — receive-side strip (an older sender syncs the whole vault)', () => {
  it('strips and counts metered names at a non-designated machine; unknown designation strips', () => {
    const me = x25519();
    const cmd = buildSecretShareCommand({ authToken: 'a', gemini_api_key_payg: KEY_VALUE, metered_groq_bench: 'g' }, { machineId: 'm_me', encryptionPublicKey: me.pub });
    const stored: Record<string, unknown> = {};
    const logs: string[] = [];
    const h = new SecretShareHandler({ ownEncryptionPrivateKey: () => me.priv, store: { set: (k, v) => { stored[k] = v; } }, log: (m) => logs.push(m) });
    expect(h.handle(cmd, 'm_old').stored).toEqual(['authToken']);
    expect(h.lastDroppedMetered).toBe(2);
    expect(stored).not.toHaveProperty('gemini_api_key_payg');
    // Logs carry a count, never a name or value.
    expect(logs.join('\n')).not.toContain(KEY_VALUE);
    expect(logs.join('\n')).not.toContain('gemini_api_key_payg');
  });

  it('keeps the metered key at the designated machine', () => {
    const me = x25519();
    const cmd = buildSecretShareCommand({ gemini_api_key_payg: KEY_VALUE }, { machineId: 'm_me', encryptionPublicKey: me.pub });
    const h = new SecretShareHandler({
      ownEncryptionPrivateKey: () => me.priv,
      store: { set: () => {} },
      selfMachineId: () => 'm_me',
      meteredDesignation: () => ({ designatedMachineId: 'm_me' }),
    });
    expect(h.handle(cmd, 'm_x').stored).toEqual(['gemini_api_key_payg']);
    expect(h.lastDroppedMetered).toBe(0);
  });
});

describe('whole-vault consumers emit names or ciphertext only', () => {
  it('secretKeyPaths returns names, never values', () => {
    const names = secretKeyPaths({ gemini_api_key_payg: KEY_VALUE, a: { b: 'c' } });
    expect(names).toEqual(['gemini_api_key_payg', 'a.b']);
    expect(JSON.stringify(names)).not.toContain(KEY_VALUE);
  });

  it('the sync payload is ciphertext: the key value never appears in it', () => {
    const r = x25519();
    const cmd = buildSecretShareCommand({ gemini_api_key_payg: KEY_VALUE }, { machineId: 'm', encryptionPublicKey: r.pub });
    expect(cmd.encrypted).not.toContain(KEY_VALUE);
  });
});

describe('secret-get.mjs — refuses metered names at the top of the script (§4.2)', () => {
  const scriptSrc = path.resolve(__dirname, '../../src/templates/scripts/secret-get.mjs');
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-get-metered-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    // A plain-config copy exists: the refusal must still come BEFORE the fallback.
    fs.writeFileSync(path.join(tmpDir, '.instar', 'config.json'), JSON.stringify({ gemini_api_key_payg: KEY_VALUE, metered_gemini_bench: KEY_VALUE, metered_new_bench: KEY_VALUE }));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/metered-secret-confinement.test.ts:afterEach' });
  });
  const run = (args: string[]) => spawnSync(process.execPath, [scriptSrc, ...args], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, VITEST: '1' } });

  for (const name of ['gemini_api_key_payg', 'metered_gemini_bench', 'metered_openrouter_bench', 'metered_groq_bench', 'metered_new_bench']) {
    it(`refuses ${name} on stdout, exit 3, value never printed`, () => {
      const r = run([name]);
      expect(r.status).toBe(3);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('refused: metered key');
      expect(r.stderr).not.toContain(KEY_VALUE);
    });
  }

  it('refuses in the --run branch before the command ever runs', () => {
    const marker = path.join(tmpDir, 'ran');
    const r = run(['gemini_api_key_payg', '--run', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
    expect(r.status).toBe(3);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a non-metered key still falls through to normal resolution', () => {
    fs.writeFileSync(path.join(tmpDir, '.instar', 'config.json'), JSON.stringify({ authToken: 'plain' }));
    const r = run(['authToken']);
    expect(r.status).not.toBe(3);
  });

  it('template-drift pin: the literal list equals METERED_SECRET_NAMES and the prefix', () => {
    const text = fs.readFileSync(scriptSrc, 'utf8');
    const m = text.match(/const METERED_SECRET_NAMES = (\[[^\]]*\]);/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1].replace(/'/g, '"'))).toEqual([...METERED_SECRET_NAMES]);
    expect(text).toContain(`const METERED_SECRET_PREFIX = '${METERED_SECRET_PREFIX}';`);
  });
});

describe('lint-metered-secret-readers — one named reader (§4.1)', () => {
  it('flags named reads and allows labels', async () => {
    const lint = await import('../../scripts/lint-metered-secret-readers.js');
    expect(lint.scanText(`const v = store.get('gemini_api_key_payg');`)).toHaveLength(1);
    expect(lint.scanText(`const v = secrets.get("metered_groq_bench");`)).toHaveLength(1);
    expect(lint.scanText(`execSync('node .instar/scripts/secret-get.mjs metered_gemini_bench')`)).toHaveLength(1);
    expect(lint.scanText(`const k = process.env.metered_openrouter_bench;`)).toHaveLength(1);
    expect(lint.scanText(`const k = getSecret('metered_x');`)).toHaveLength(1);
    // Reads through the exported constants count too (second-pass review note 1).
    expect(lint.scanText(`const v = store.get(GEMINI_PAYG_SECRET_NAME);`)).toHaveLength(1);
    expect(lint.scanText(`const v = secrets.get(METERED_SECRET_NAMES[1]);`)).toHaveLength(1);
    expect(lint.scanText(`const v = process.env[GEMINI_PAYG_SECRET_NAME];`)).toHaveLength(1);
    // Labels and refusal lists are not reads.
    expect(lint.scanText(`{ door: 'gemini-api', keyRef: 'metered_gemini_bench' }`)).toHaveLength(0);
    expect(lint.scanText(`const NAMES = ['gemini_api_key_payg'];`)).toHaveLength(0);
    expect(lint.scanText(`store.get('authToken')`)).toHaveLength(0);
  });

  it('the repo is clean today', async () => {
    const lint = await import('../../scripts/lint-metered-secret-readers.js');
    expect(lint.scanRepo()).toEqual([]);
  });
});

describe('value-based child-env canary across the five frameworks (§4.4)', () => {
  // Every name a Google/metered key could travel under, plus an arbitrary name.
  // ANTHROPIC_* is deliberately absent: the Claude reviewer env passes the operator's
  // own ANTHROPIC_* settings (base-URL proxy, Anthropic's own api-key path) by design,
  // and a Google key never carries an Anthropic name.
  const NAMES = [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY',
    'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY',
    'gemini_api_key_payg', 'metered_gemini_bench', 'INSTAR_ARBITRARY_CANARY_NAME',
  ];
  const planted: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/x' };
  for (const n of NAMES) planted[n] = KEY_VALUE;

  const absent = (env: NodeJS.ProcessEnv) => {
    expect(Object.values(env).some((v) => typeof v === 'string' && v.includes(KEY_VALUE))).toBe(false);
  };

  it('gemini-cli', () => absent(buildGeminiChildEnv(planted)));
  it('pi-cli', () => absent(buildPiChildEnv(planted)));
  it('grok-build', () => absent(buildGrokChildEnv(planted)));
  it('claude-code reviewer', () => absent(buildClaudeReviewerChildEnv(planted)));
  it('codex-cli (reads process.env)', () => {
    const saved: Record<string, string | undefined> = {};
    for (const n of NAMES) { saved[n] = process.env[n]; process.env[n] = KEY_VALUE; }
    try {
      absent(buildCodexChildEnv({ subscriptionOnly: true }));
    } finally {
      for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    }
  });
});
