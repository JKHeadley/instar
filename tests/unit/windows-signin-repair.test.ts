/**
 * Windows sign-in repair (spec windows-signin-repair): the WSL facts, the profile's Windows folder,
 * the skill subsection existing agents receive, and a repair that reaches the Windows folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isWindowsProfileDir, isWslHost, windowsDirToWslPath } from '../../src/core/wslPlatform.js';
import { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SUBSCRIPTION_SIGNIN_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';

const OPERATION = 'tests/unit/windows-signin-repair.test.ts';
const WINDOWS_MARKER = '### On Windows (WSL): the same steps through ndrive.sh';
const AGENT_RUN = '### Agent-run repair (when Instar starts you as the sign-in helper)';

describe('wslPlatform', () => {
  it('reads WSL from the kernel release, on Linux only', () => {
    expect(isWslHost('linux', '6.18.33.2-microsoft-standard-WSL2')).toBe(true);
    expect(isWslHost('linux', '6.8.0-45-generic')).toBe(false);
    expect(isWslHost('darwin', '25.5.0')).toBe(false);
  });

  it('accepts only the spelling ndrive.sh accepts', () => {
    expect(isWindowsProfileDir('C:\\Users\\Public\\Profiles\\echo')).toBe(true);
    for (const bad of ['/mnt/c/x', 'C:/Users/x', 'C:\\', 'relative\\x', 'C:\\a\\\\b', 'C:\\a\\..\\b', 'C:\\a.\\b',
      'C:\\a \\b', 'C:\\a*', 'C:\\PROGRA~1\\x', 'C:\\a"b', "C:\\a'b", 'C:\\a\nb', '\\\\wsl.localhost\\Ubuntu\\x']) {
      expect(isWindowsProfileDir(bad), bad).toBe(false);
    }
  });

  it('maps a Windows folder onto its WSL mount', () => {
    expect(windowsDirToWslPath('C:\\Users\\Public\\p')).toBe('/mnt/c/Users/Public/p');
    expect(windowsDirToWslPath('/home/echo')).toBeNull();
  });
});

describe('profile registry — Windows folder', () => {
  let dir: string;
  const present = new Set<string>();
  const registry = () => new PlaywrightProfileRegistry({ stateDir: path.join(dir, '.instar'), projectDir: dir,
    listVaultNames: () => [], windowsDirExists: (folder) => present.has(folder) });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-windows-profile-'));
    fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
    present.clear();
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OPERATION }); });

  it('reports the Windows folder as the profile directory once set, on both sides of existence', () => {
    registry().createProfile({ id: 'p1' });
    expect(registry().listProfiles().find((p) => p.id === 'p1')!.dirExists).toBe(false);
    registry().setWindowsUserDataDir('p1', 'C:\\Users\\Public\\p1');
    expect(registry().listProfiles().find((p) => p.id === 'p1')!.dirExists).toBe(false);
    present.add('C:\\Users\\Public\\p1');
    const detail = registry().listProfiles().find((p) => p.id === 'p1')!;
    expect(detail.dirExists).toBe(true);
    expect(detail.windowsUserDataDir).toBe('C:\\Users\\Public\\p1');
  });

  it('refuses a bad path and an unknown profile, and clears with null', () => {
    registry().createProfile({ id: 'p1' });
    expect(() => registry().setWindowsUserDataDir('p1', '/mnt/c/x')).toThrow(/Windows path/);
    expect(() => registry().setWindowsUserDataDir('nope', 'C:\\x\\y')).toThrow(/not found/);
    registry().setWindowsUserDataDir('p1', 'C:\\x\\y');
    registry().setWindowsUserDataDir('p1', null);
    expect(registry().listProfiles().find((p) => p.id === 'p1')!.windowsUserDataDir).toBeUndefined();
  });
});

describe('PostUpdateMigrator — subscription-signin Windows subsection', () => {
  let projectDir: string;
  const skillFile = () => path.join(projectDir, '.claude', 'skills', 'subscription-signin', 'SKILL.md');
  type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
  function run(): Result {
    const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const result: Result = { upgraded: [], skipped: [], errors: [] };
    (migrator as unknown as { migrateSubscriptionSigninWindows(r: Result): void }).migrateSubscriptionSigninWindows(result);
    return result;
  }
  // The version before this change: no Windows subsection, and the macOS-only agent-run line.
  const before = (SUBSCRIPTION_SIGNIN_SKILL_CONTENT.slice(0, SUBSCRIPTION_SIGNIN_SKILL_CONTENT.indexOf(WINDOWS_MARKER))
    + SUBSCRIPTION_SIGNIN_SKILL_CONTENT.slice(SUBSCRIPTION_SIGNIN_SKILL_CONTENT.indexOf(AGENT_RUN)))
    .replace('On macOS and on Windows (WSL) the built-in repair', 'On macOS the built-in repair');
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-signin-windows-'));
    fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.instar'));
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OPERATION }); });

  it('turns the previous stock skill into the shipped one, and is idempotent', () => {
    fs.writeFileSync(skillFile(), before);
    expect(run().upgraded).toHaveLength(1);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(SUBSCRIPTION_SIGNIN_SKILL_CONTENT);
    expect(run().upgraded).toHaveLength(0);
  });

  it('keeps local edits, and leaves a copy without the agent-run subsection alone', () => {
    fs.writeFileSync(skillFile(), `${before}\n- my local note\n`);
    run();
    const after = fs.readFileSync(skillFile(), 'utf8');
    expect(after).toContain(WINDOWS_MARKER);
    expect(after).toContain('- my local note');
    fs.writeFileSync(skillFile(), '---\nname: subscription-signin\n---\nmine');
    expect(run().skipped).toHaveLength(1);
    expect(fs.readFileSync(skillFile(), 'utf8')).not.toContain(WINDOWS_MARKER);
  });

  it('tells the helper the link cannot go on argv', () => {
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('ndrive.sh typesecret');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('ERR secret-shaped-url');
  });
});
