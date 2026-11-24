/** Shared read-only browser status projection. No pairing initialization or authority is created here. */
import type { Request, RequestHandler } from 'express';
import { CHUNK_BYTES, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_MESSAGE_BYTES } from '../core/appMediaTypes.js';
export interface BrowserStatusReadDeps {
  browserOn: () => boolean;
  bearerOk: (req: Request) => boolean;
  machineId: () => string | null;
  nickname: (id: string | null) => string | null;
  projectName: () => string | undefined;
  approvalPath: () => 'telegram' | 'dashboard' | null;
  approvalChat?: () => Promise<{ name: string; username: string | null } | null>;
  approveEnabled: () => boolean;
  ownerPhoneCanApprove: () => boolean;
  telegramConfigured: () => boolean;
  holdsLease: () => boolean;
  telegramOwnerPresent?: () => boolean;
  keyState: (keyHash: string) => unknown;
  now?: () => number;
}
export function createBrowserStatusRead(deps: BrowserStatusReadDeps): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.browserOn()) { res.status(503).json({ error: 'browser-devices-off', detail: 'Conversations in the dashboard are switched off on this agent.' }); return; }
    if (!deps.bearerOk(req)) { res.status(403).json({ error: 'bearer-required' }); return; }
    const machineId = deps.machineId();
    const kh = typeof req.query.keyHash === 'string' ? req.query.keyHash.toLowerCase() : null;
    if (kh !== null && !/^[0-9a-f]{64}$/.test(kh)) { res.status(400).json({ error: 'bad-key-hash' }); return; }
    const approvalChat = deps.approvalPath() === 'telegram' && deps.approvalChat
      ? await Promise.race([deps.approvalChat().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500).unref?.())])
      : null;
    res.json({
      enabled: true, machineId, nickname: deps.nickname(machineId) ?? deps.projectName() ?? null, approvalChat,
      serverTime: deps.now?.() ?? Date.now(), approvalPath: deps.approvalPath(), approveEnabled: deps.approveEnabled(),
      ownerPhoneApproves: deps.approveEnabled() && deps.ownerPhoneCanApprove(),
      telegramSend: deps.telegramConfigured() && deps.holdsLease() && (deps.telegramOwnerPresent ? deps.telegramOwnerPresent() : true),
      limits: { maxFiles: MAX_ATTACHMENTS, maxMessageBytes: MAX_MESSAGE_BYTES, maxFileBytes: MAX_FILE_BYTES, chunkBytes: CHUNK_BYTES },
      ...(kh ? { key: deps.keyState(kh) } : {}),
    });
  };
}
