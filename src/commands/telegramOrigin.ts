/**
 * `instar telegram-origin enroll-browser <profile>` — the reviewed, trusted
 * entrypoint for Telegram Web K drift (docs/specs/telegram-message-origin.md).
 * Deliberately a local CLI, never an HTTP route: it retires the managed
 * profile's browser, runs the authenticated READ-ONLY canary, and enrolls the
 * observed build only when it is on the reviewed list. It sends nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { PlaywrightProfileRegistry } from '../core/PlaywrightProfileRegistry.js';
import { BrowserEnrollmentRefusal, enrollReviewedOriginBrowser } from '../messaging/telegram-origin/OriginBrowserEnrollment.js';

export interface EnrollBrowserOptions { dir?: string; evidenceOut?: string; }

export async function telegramOriginEnrollBrowser(profileId: string, options: EnrollBrowserOptions): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(options.dir); }
  catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }
  const registry = new PlaywrightProfileRegistry({ stateDir: config.stateDir, projectDir: config.projectDir, listVaultNames: () => null });
  const startedAt = new Date().toISOString();
  try {
    const result = await enrollReviewedOriginBrowser({ registry, profileId });
    const supportedBuilds = result.profile.telegramBroker?.supportedBuilds.map(b => b.buildId) ?? [];
    const record = { startedAt, completedAt: new Date().toISOString(), kind: 'authenticated-read-only-enrollment-inspection',
      result: 'enrolled', buildId: result.build.buildId, evidence: result.build.evidence, ...result.canary, supportedBuilds, messagesSent: 0 };
    if (options.evidenceOut) fs.writeFileSync(path.resolve(options.evidenceOut), JSON.stringify(record, null, 2) + '\n');
    console.log(pc.green(`Enrolled ${profileId} for ${result.build.buildId}. Supported builds: ${supportedBuilds.join(', ')}.`));
    console.log(JSON.stringify(record, null, 2));
    console.log('The running server picks this up at its next browser start; no message was sent.');
  } catch (error) {
    const reason = error instanceof BrowserEnrollmentRefusal ? error.reason : error instanceof Error ? error.message : String(error);
    const detail = error instanceof BrowserEnrollmentRefusal ? error.detail : {};
    const record = { startedAt, completedAt: new Date().toISOString(), kind: 'authenticated-read-only-enrollment-inspection',
      result: 'refused', reason, ...detail, messagesSent: 0 };
    if (options.evidenceOut) fs.writeFileSync(path.resolve(options.evidenceOut), JSON.stringify(record, null, 2) + '\n');
    console.log(pc.red(`Refused: ${reason}. The existing enrollment is unchanged, but the browser that was running on this profile was stopped; the server starts a fresh one on its next use.`));
    console.log(JSON.stringify(record, null, 2));
    process.exitCode = 1;
  }
}
