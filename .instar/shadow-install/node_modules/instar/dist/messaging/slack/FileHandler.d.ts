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
import type { SlackApiClient } from './SlackApiClient.js';
export declare class FileHandler {
    private api;
    private botToken;
    private filesDir;
    constructor(api: SlackApiClient, botToken: string, stateDir: string);
    /**
     * Upload a file to a Slack channel using the v2 three-step flow.
     * files.upload is deprecated and unavailable for new apps.
     */
    uploadFile(channelId: string, filePath: string, title?: string): Promise<void>;
    /**
     * Download a file from Slack.
     * Validates destPath to prevent path traversal — must resolve inside filesDir.
     */
    downloadFile(url: string, destPath: string): Promise<string>;
    /** Get the base directory for downloaded files. */
    get downloadDir(): string;
}
//# sourceMappingURL=FileHandler.d.ts.map