/**
 * FileHandler — Slack file upload (v2 API) and download with security guards.
 *
 * Upload uses the three-step flow required for apps created after May 2024:
 *   1. files.getUploadURLExternal → get upload URL
 *   2. PUT file content to upload URL (validate hostname first)
 *   3. files.completeUploadExternal → share to channel
 *
 * Download validates paths to prevent traversal attacks.
 */

// CONTRACT-EVIDENCE: EXEMPT — message-origin-all-platforms adds no Slack API method, parameter or response field: the origin ledger wraps the existing calls (reading only `ts`) and the footer is one more line of `text`. Echo's Slack bot token was revoked 2026-07-01, so no live contract run is available.
import type { SlackOriginLedger } from './SlackOriginLedger.js';
import fs from 'node:fs';
import path from 'node:path';
import type { SlackApiClient } from './SlackApiClient.js';
import { validateSlackHostname } from './sanitize.js';

// CONTRACT-EVIDENCE: EXEMPT — the v2 three-step upload flow is unchanged; this only adds Slack's documented
// optional `thread_ts` and `initial_comment` fields to files.completeUploadExternal and lets a caller name the
// file. No live run was possible: Echo's Slack bot token was revoked 2026-07-01 (config _teardownNote). Run
// `npm run test:contract` when Slack is re-provisioned (docs/runbooks/slack-live-test-reprovision.md).
/** Optional extras for an upload: a thread to post into, a message beside the file, and the file's name. */
export interface SlackUploadOptions { threadTs?: string; initialComment?: string; filename?: string }

export class FileHandler {
  private api: SlackApiClient;
  private botToken: string;
  private filesDir: string;

  constructor(api: SlackApiClient, botToken: string, stateDir: string, private readonly originLedger?: SlackOriginLedger) {
    this.api = api;
    this.botToken = botToken;
    this.filesDir = path.join(stateDir, 'slack-files');
    fs.mkdirSync(this.filesDir, { recursive: true });
  }

  /**
   * Upload a file to a Slack channel using the v2 three-step flow.
   * files.upload is deprecated and unavailable for new apps.
   */
  async uploadFile(channelId: string, filePath: string, title?: string, options?: SlackUploadOptions): Promise<void> {
    const stats = await fs.promises.stat(filePath);
    // A caller may name the file (the app's display name for a stored blob, whose path is a hash).
    const fileName = options?.filename ? options.filename.replace(/[\x00-\x1f\x7f/\\]/g, '').trim().slice(0, 200) || path.basename(filePath) : path.basename(filePath);

    // Step 1: Get upload URL
    const urlResponse = await this.api.call('files.getUploadURLExternal', {
      filename: fileName,
      length: stats.size,
    });

    const uploadUrl = urlResponse.upload_url as string;

    // SSRF prevention: validate hostname is *.slack.com
    if (!validateSlackHostname(uploadUrl)) {
      throw new Error(`[slack-file] Refusing upload: URL hostname is not *.slack.com: ${new URL(uploadUrl).hostname}`);
    }

    // Step 2: PUT file content
    const fileContent = await fs.promises.readFile(filePath);
    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      body: fileContent,
    });

    if (!putResponse.ok) {
      throw new Error(`[slack-file] Upload PUT failed: ${putResponse.status} ${putResponse.statusText}`);
    }

    // Step 3: Complete upload and share to channel
    // message-origin-all-platforms §3: the share puts a file (and its comment) in front of a user,
    // so it records its origin first; a refused record refuses the share.
    const intent = this.originLedger?.beginIntent('files.completeUploadExternal', channelId, options?.threadTs ?? null);
    // (A refused share throws SlackOriginRecordingError here; the caller's mirror reports "failed".)
    await this.api.call('files.completeUploadExternal', {
      files: [{ id: urlResponse.file_id as string, title: title || fileName }],
      channel_id: channelId,
      // Into a thread, and with a message beside the file, when the caller asks (both optional).
      ...(options?.threadTs ? { thread_ts: options.threadTs } : {}),
      ...(options?.initialComment ? { initial_comment: options.initialComment } : {}),
    });
    if (intent) this.originLedger!.completeReceipt(intent, null);
  }

  /**
   * Download a file from Slack.
   * Validates destPath to prevent path traversal — must resolve inside filesDir.
   */
  async downloadFile(url: string, destPath: string): Promise<string> {
    // Path traversal protection
    const resolvedPath = path.resolve(this.filesDir, destPath);
    if (!resolvedPath.startsWith(this.filesDir + path.sep) && resolvedPath !== this.filesDir) {
      throw new Error(`[slack-file] Path traversal blocked: ${destPath} resolves outside ${this.filesDir}`);
    }

    // Ensure destination directory exists
    const destDir = path.dirname(resolvedPath);
    await fs.promises.mkdir(destDir, { recursive: true });

    // Download with auth header.
    // Use manual redirect handling to preserve the Authorization header across redirects.
    // Node.js fetch (undici) strips Authorization on cross-origin redirects per spec,
    // which causes Slack CDN redirects to return HTML login pages instead of file content.
    let response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.botToken}`,
      },
      redirect: 'manual',
    });

    // Follow redirects manually, preserving auth header
    let redirectCount = 0;
    while (response.status >= 300 && response.status < 400 && redirectCount < 5) {
      const location = response.headers.get('location');
      if (!location) break;
      response = await fetch(location, {
        headers: {
          Authorization: `Bearer ${this.botToken}`,
        },
        redirect: 'manual',
      });
      redirectCount++;
    }

    if (!response.ok) {
      throw new Error(`[slack-file] Download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(resolvedPath, buffer);

    return resolvedPath;
  }

  /** Get the base directory for downloaded files. */
  get downloadDir(): string {
    return this.filesDir;
  }
}
