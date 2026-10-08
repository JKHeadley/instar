/**
 * Unit — one writer for threadline/identity.json, and a truthful boot line.
 * Spec: docs/specs/threadline-identity-single-writer.md (ACT-062)
 *
 *  1. A source scan that FAILS if any module other than the identity key-file
 *     module writes an `identity.json`. It is proven to detect the removed
 *     HandshakeManager writer by running it over that code.
 *  2. HandshakeManager uses the agent's one identity and writes no identity file.
 *  3. describeRelayBootStatus says "connected" only for a connected client.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { describeRelayBootStatus } from '../../../src/threadline/relayBootStatus.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const SRC = path.resolve(__dirname, '../../../src');

/** The only module allowed to hold a raw fs write for an agent identity file. */
const KEY_FILE_MODULE = 'identity/IdentityKeyFile.ts';

/**
 * Files that write a DIFFERENT file which happens to be named identity.json.
 * Each entry needs a reason; an agent identity writer never belongs here.
 */
const UNRELATED_IDENTITY_JSON: Record<string, string> = {
  'core/MachineSshIdentity.ts': 'SSH key metadata under the machine-ssh root, not the agent identity',
};

// A raw fs write, however the function was imported: `fs.writeFileSync(`,
// a bare `writeFileSync(`, or an aliased `nodeWriteFileSync(`.
const WRITE_CALL = /(?<![\w$.])(?:fs(?:\.promises)?\.)?(?:node)?([wW]riteFileSync|[wW]riteFile|[aA]ppendFileSync|[aA]ppendFile|[rR]enameSync|[rR]ename|[cC]opyFileSync|[cC]opyFile|[lL]inkSync|[cC]reateWriteStream)\s*\(\s*([^,)]+)/g;

/**
 * Find raw fs writes whose target is an identity.json path: either the path is
 * built inline, or it is an identifier/property assigned (on one line) from an
 * expression that names identity.json, or from one such identifier — which
 * also catches a temp path derived from it, e.g. `${identityPath}.tmp`.
 */
function findIdentityFileWrites(source: string): string[] {
  const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^;\n]+)|this\.([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  // A value READ from the file (JSON.parse(readFileSync(...))) is content, not a path.
  const assignments = [...source.matchAll(assign)]
    .map(m => ({ name: (m[1] ?? m[3])!, expr: m[2] ?? m[4] ?? '' }))
    .filter(a => !/readFile|JSON\.parse|existsSync|statSync/.test(a.expr));
  const direct = new Set(assignments.filter(a => /identity\.json/.test(a.expr)).map(a => a.name));
  const derived = new Set(direct);
  for (const a of assignments) {
    if ([...direct].some(n => new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(a.expr))) derived.add(a.name);
  }
  const hits: string[] = [];
  for (const m of source.matchAll(WRITE_CALL)) {
    const target = m[2].trim();
    const bare = target.replace(/^this\./, '');
    if (/identity\.json/.test(target) || derived.has(bare)) hits.push(`${m[1]}(${target})`);
  }
  return hits;
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('single writer for identity key files', () => {
  it('the scanner detects the removed HandshakeManager hex writer', () => {
    const removedWriter = `
      private getOrCreateIdentity(): KeyPair {
        const identityPath = path.join(this.stateDir, 'identity.json');
        this.identityKey = generateIdentityKeyPair();
        fs.writeFileSync(identityPath, JSON.stringify(stored, null, 2));
        return this.identityKey;
      }`;
    expect(findIdentityFileWrites(removedWriter)).toEqual(['writeFileSync(identityPath)']);
  });

  it('the scanner detects a write through a derived temp path and a class field', () => {
    const viaTemp = `
      this.legacyKeyFile = path.join(stateDir, 'threadline', 'identity.json');
      const tmpPath = \`\${this.legacyKeyFile}.tmp\`;
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, this.legacyKeyFile);`;
    expect(findIdentityFileWrites(viaTemp)).toEqual(['writeFileSync(tmpPath)', 'renameSync(tmpPath)']);
  });

  it('no module other than the identity key-file module writes an identity.json', () => {
    const offenders: string[] = [];
    for (const file of listTs(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === KEY_FILE_MODULE || rel in UNRELATED_IDENTITY_JSON) continue;
      const source = fs.readFileSync(file, 'utf-8');
      if (!source.includes('identity.json')) continue;
      for (const hit of findIdentityFileWrites(source)) offenders.push(`${rel}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the unrelated-file allowlist never names a threadline or identity module', () => {
    for (const rel of Object.keys(UNRELATED_IDENTITY_JSON)) {
      expect(rel.startsWith('threadline/') || rel.startsWith('identity/')).toBe(false);
      expect(fs.readFileSync(path.join(SRC, rel), 'utf-8')).not.toMatch(/'threadline'/);
    }
  });

  it('the scanner sees through aliased fs imports', () => {
    const aliased = `
      import { writeFileSync as nodeWriteFileSync, renameSync as nodeRenameSync } from 'node:fs';
      const target = nodeJoin(stateDir, 'identity.json');
      nodeWriteFileSync(target, data);`;
    expect(findIdentityFileWrites(aliased)).toEqual(['WriteFileSync(target)']);
  });

  it('only three modules both reach the write primitive and name the legacy threadline path', () => {
    const LEGACY_PATH = /'threadline',\s*'identity\.json'|threadline\/identity\.json'/;
    const namers: string[] = [];
    for (const file of listTs(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      const source = fs.readFileSync(file, 'utf-8');
      if (LEGACY_PATH.test(source) && /IdentityKeyFile\.js'/.test(source)) namers.push(rel);
    }
    expect(namers.sort()).toEqual([
      'core/AgentIdentityHandover.ts', // READS the legacy file for a handover; see next test
      'identity/Migration.ts',         // repairs it through the validating reader
      'threadline/client/IdentityManager.ts',
    ]);
  });

  it('the pairing installer writes the canonical file only, never the legacy one', () => {
    const source = fs.readFileSync(path.join(SRC, 'core/AgentIdentityHandover.ts'), 'utf-8');
    const start = source.indexOf('export function installAgentIdentityFromPairing');
    const installer = source.slice(start);
    expect(start).toBeGreaterThan(-1);
    expect(installer).toMatch(/nodeJoin\(input\.stateDir, 'identity\.json'\)/);
    expect(installer).not.toMatch(/'threadline'/);
    expect(installer).toMatch(/writeFileAtomicOwnerOnly\(target, data\)/);
  });

  it('the key-file module is reached only through the identity modules, the pairing installer and the handshake token store', () => {
    const importers: string[] = [];
    for (const file of listTs(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === KEY_FILE_MODULE) continue;
      if (/from\s+'[^']*IdentityKeyFile\.js'/.test(fs.readFileSync(file, 'utf-8'))) importers.push(rel);
    }
    expect(importers.sort()).toEqual([
      'core/AgentIdentityHandover.ts',
      'identity/IdentityManager.ts',
      'identity/Migration.ts',
      'threadline/HandshakeManager.ts',
      'threadline/ThreadlineBootstrap.ts', // imports the error TYPE only
      'threadline/client/IdentityManager.ts',
    ]);
    expect(fs.readFileSync(path.join(SRC, 'threadline/ThreadlineBootstrap.ts'), 'utf-8'))
      .toMatch(/import \{ IdentityFileInvalidError \} from '\.\.\/identity\/IdentityKeyFile\.js'/);
  });

  it('HandshakeManager source no longer generates or stores an identity key', () => {
    const source = fs.readFileSync(path.join(SRC, 'threadline/HandshakeManager.ts'), 'utf-8');
    expect(source).not.toMatch(/generateIdentityKeyPair/);
    expect(source).not.toMatch(/identity\.json/);
  });
});

describe('HandshakeManager — identity comes from the one identity source', () => {
  let stateDir: string;
  const legacyFile = (): string => path.join(stateDir, 'threadline', 'identity.json');

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-single-writer-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/threadline/identity-single-writer.test.ts:cleanup' });
  });

  it('constructing it, and listing pairs, creates no identity file', () => {
    const hs = new HandshakeManager(stateDir, 'agent');
    hs.listPairedAgents();
    hs.isHandshakeInProgress('peer');
    expect(fs.existsSync(legacyFile())).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'identity.json'))).toBe(false);
  });

  it('a handshake uses the SAME key the relay client would register', () => {
    const hs = new HandshakeManager(stateDir, 'agent');
    const hello = hs.initiateHandshake('peer');
    if ('error' in hello) throw new Error('handshake refused');
    const relayIdentity = new IdentityManager(stateDir).getOrCreate();
    expect(Buffer.from(hello.payload.identityPub, 'hex').equals(relayIdentity.publicKey)).toBe(true);
    expect(hs.getIdentityPublicKey()).toBe(relayIdentity.publicKey.toString('hex'));
  });

  it('an identity minted by a handshake is stored as base64, 0600, by the identity manager', () => {
    new HandshakeManager(stateDir, 'agent').initiateHandshake('peer');
    const stored = JSON.parse(fs.readFileSync(legacyFile(), 'utf-8'));
    expect(Buffer.from(stored.publicKey, 'base64').length).toBe(32);
    expect(Buffer.from(stored.privateKey, 'base64').length).toBe(32);
    expect(/^[0-9a-f]{64}$/.test(stored.publicKey)).toBe(false);
    expect(typeof stored.fingerprint).toBe('string');
    expect(fs.statSync(legacyFile()).mode & 0o777).toBe(0o600);
  });

  it('uses an existing identity instead of minting a second one', () => {
    const existing = new IdentityManager(stateDir).getOrCreate();
    const before = fs.readFileSync(legacyFile(), 'utf-8');
    expect(new HandshakeManager(stateDir, 'agent').getIdentityPublicKey()).toBe(existing.publicKey.toString('hex'));
    expect(fs.readFileSync(legacyFile(), 'utf-8')).toBe(before);
  });

  it('two agents can complete a handshake with identity-manager keys, and tokens are stored 0600', () => {
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-single-writer-b-'));
    try {
      const a = new HandshakeManager(stateDir, 'a');
      const b = new HandshakeManager(dirB, 'b');
      const hello = a.initiateHandshake('b');
      if ('error' in hello) throw new Error('hello refused');
      const response = b.handleHello(hello.payload);
      if ('error' in response) throw new Error('hello response refused');
      const confirm = a.handleHelloResponse(response.payload);
      if ('error' in confirm) throw new Error('confirm refused');
      const done = b.handleConfirm(confirm.confirmPayload);
      if ('error' in done) throw new Error('confirm rejected');
      expect(done.relayToken).toBe(confirm.relayToken);
      expect(fs.statSync(path.join(stateDir, 'threadline', 'relay-tokens.json')).mode & 0o777).toBe(0o600);
    } finally {
      SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/unit/threadline/identity-single-writer.test.ts:cleanup-b' });
    }
  });

  it('refuses to mint over an unusable identity file', () => {
    fs.mkdirSync(path.dirname(legacyFile()), { recursive: true });
    fs.writeFileSync(legacyFile(), 'garbage');
    const hs = new HandshakeManager(stateDir, 'agent');
    expect(() => hs.initiateHandshake('peer')).toThrow(/cannot be used/);
    expect(fs.readFileSync(legacyFile(), 'utf-8')).toBe('garbage');
  });
});

describe('describeRelayBootStatus — the boot line reports the real state', () => {
  it('says connected only when the client is connected', () => {
    const s = describeRelayBootStatus('relay.example', 'connected');
    expect(s.connected).toBe(true);
    expect(s.text).toBe('Threadline: relay connected to relay.example');
  });

  it.each(['disconnected', 'connecting', 'authenticating', 'displaced', ''])(
    'never claims a connection in state "%s"',
    (state) => {
      const s = describeRelayBootStatus('relay.example', state);
      expect(s.connected).toBe(false);
      expect(s.text).toMatch(/NOT connected/);
      expect(s.text).not.toMatch(/relay connected to/);
    },
  );

  it('explains the daemon case without claiming a connection', () => {
    const s = describeRelayBootStatus('relay.example', 'disconnected', { daemonHandlingRelay: true });
    expect(s.connected).toBe(false);
    expect(s.text).toMatch(/listener daemon owns it/);
    expect(s.text).not.toMatch(/relay connected to/);
  });

  it('server.ts prints this line and no longer has the unconditional one', () => {
    const server = fs.readFileSync(path.join(SRC, 'commands/server.ts'), 'utf-8');
    expect(server).toMatch(/describeRelayBootStatus\(/);
    expect(server).toMatch(/threadlineRelayClient\.connectionState/);
    expect(server).not.toMatch(/pc\.green\(`\s*Threadline: relay connected to/);
  });
});
