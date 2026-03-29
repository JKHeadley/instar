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
import fs from 'node:fs';
import path from 'node:path';
import { validateSlackHostname } from './sanitize.js';
export class FileHandler {
    api;
    botToken;
    filesDir;
    constructor(api, botToken, stateDir) {
        this.api = api;
        this.botToken = botToken;
        this.filesDir = path.join(stateDir, 'slack-files');
        fs.mkdirSync(this.filesDir, { recursive: true });
    }
    /**
     * Upload a file to a Slack channel using the v2 three-step flow.
     * files.upload is deprecated and unavailable for new apps.
     */
    async uploadFile(channelId, filePath, title) {
        const stats = await fs.promises.stat(filePath);
        const fileName = path.basename(filePath);
        // Step 1: Get upload URL
        const urlResponse = await this.api.call('files.getUploadURLExternal', {
            filename: fileName,
            length: stats.size,
        });
        const uploadUrl = urlResponse.upload_url;
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
        await this.api.call('files.completeUploadExternal', {
            files: [{ id: urlResponse.file_id, title: title || fileName }],
            channel_id: channelId,
        });
    }
    /**
     * Download a file from Slack.
     * Validates destPath to prevent path traversal — must resolve inside filesDir.
     */
    async downloadFile(url, destPath) {
        // Path traversal protection
        const resolvedPath = path.resolve(this.filesDir, destPath);
        if (!resolvedPath.startsWith(this.filesDir + path.sep) && resolvedPath !== this.filesDir) {
            throw new Error(`[slack-file] Path traversal blocked: ${destPath} resolves outside ${this.filesDir}`);
        }
        // Ensure destination directory exists
        const destDir = path.dirname(resolvedPath);
        await fs.promises.mkdir(destDir, { recursive: true });
        // Download with auth header
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.botToken}`,
            },
        });
        if (!response.ok) {
            throw new Error(`[slack-file] Download failed: ${response.status} ${response.statusText}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.promises.writeFile(resolvedPath, buffer);
        return resolvedPath;
    }
    /** Get the base directory for downloaded files. */
    get downloadDir() {
        return this.filesDir;
    }
}
//# sourceMappingURL=FileHandler.js.map