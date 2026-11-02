/** Guided Remote Desktop setup. The dashboard PIN session is the only way in:
 * a Bearer token alone is refused. Spec: docs/specs/desktop-guided-setup.md */
import { Router, type Request, type Response as ExpressResponse } from 'express';
import { desktopSetupStep, parseDesktopSetupStatus, type DesktopSetupPane, type DesktopSetupStatus,
  type DesktopSetupStep } from '../core/DesktopSetupGuide.js';
import { DesktopSetupRefused, type DesktopSetupRequest, type DesktopSetupTarget } from '../core/DesktopSetupTarget.js';

// WSL boot installs its companion first, which can take 140 seconds.
const RESTART_WINDOW_MS = 200_000;
const MAX_PEERS = 7;
const MACHINE_ID = /^m_[a-f0-9]{32}$/;

export interface DesktopSetupRouteDeps {
  /** The dev-agent gate on the page and its routes. */
  enabled: () => boolean;
  selfMachineId: () => string | undefined;
  selfLabel: () => string;
  frontMachineId: () => string | undefined;
  target: () => DesktopSetupTarget | null;
  peers: () => Array<{ machineId: string; nickname?: string }>;
  /** Signed call to a peer's /api/desktop/setup. Throws with `status` and `code`
   *  on refusal. Works before this machine is the front, so a page on a machine
   *  that is still off can see which machine already is. */
  peerCall: (machineId: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Whether this process runs as the front, so a peer can be claimed. */
  frontActive: () => boolean;
  /** Same trust check the picker applies before it will open a machine. */
  targetKey: (machineId: string) => string | null;
  verifySession: (token: string) => boolean;
  transportAllowed: (req: Request) => boolean;
  now?: () => number;
}

/** Fixed wording: a peer's own text is never shown as an error. */
const REFUSAL_TEXT: Record<string, string> = {
  locked: 'That Mac is locked or has no active session, so a pop-up would do nothing.',
  wait: 'That was done in the last minute. Give it a moment, then try again.',
  'other-front': 'That machine takes Remote Desktop from a different front.',
  'front-mismatch': 'That machine takes setup from a different front.',
  'not-supported': 'Remote Desktop does not run on that kind of machine yet.',
  'not-macos': 'This step only applies to a Mac.',
  'target-off': 'Remote Desktop has not started on that machine.',
  'open-failed': 'That Mac could not open System Settings.',
  'turned-off-here': 'Remote Desktop was turned off on that machine itself. Turn it on from its own page.',
  'setup-off': 'That machine does not take setup from another machine yet.',
  'audit-failed': 'That machine could not record the change, so it made none.',
  'restart-unavailable': 'The change is saved, but that machine could not restart itself.',
};

type MachineRow = DesktopSetupStep & { machineId: string; label: string };

export function createDesktopSetupRoutes(d: DesktopSetupRouteDeps): Router {
  const router = Router();
  const now = d.now ?? Date.now;
  const restartRequestedAt = new Map<string, number>();
  const restarting = (id: string) => now() - (restartRequestedAt.get(id) ?? -Infinity) < RESTART_WINDOW_MS;

  const guard = (req: Request, res: ExpressResponse): boolean => {
    res.setHeader('Cache-Control', 'no-store');
    if (!d.enabled() || !d.target()) { res.status(503).json({ error: 'Guided setup is off on this agent' }); return false; }
    if (!d.transportAllowed(req)) {
      res.status(403).json({ error: 'Remote desktop requires the HTTPS tunnel or local access' }); return false;
    }
    const session = req.headers['x-instar-operator-session'];
    if (typeof session !== 'string' || !d.verifySession(session)) {
      res.status(403).json({ error: 'Dashboard operator session required' }); return false;
    }
    return true;
  };

  /** The configured front, else this machine, which becomes the front when set up. */
  const frontId = (): string | undefined => d.frontMachineId() ?? d.selfMachineId();
  const frontElsewhere = (): boolean => !!d.frontMachineId() && d.frontMachineId() !== d.selfMachineId();

  const statusOf = async (machineId: string): Promise<DesktopSetupStatus> => {
    if (machineId === d.selfMachineId()) {
      const target = d.target();
      if (!target) return { reachable: false };
      return parseDesktopSetupStatus(await target.run({ action: 'status' }, null));
    }
    try { return parseDesktopSetupStatus(await d.peerCall(machineId, { action: 'status' })); }
    catch (error) {
      const status = (error as { status?: number }).status;
      return status === 404 ? { reachable: true, needsUpdate: true } : { reachable: false };
    }
  };

  const nameOf = (machineId: string): string => {
    if (machineId === d.selfMachineId()) return d.selfLabel();
    return d.peers().find(peer => peer.machineId === machineId)?.nickname?.slice(0, 80) || 'Other machine';
  };

  const rowFor = async (machineId: string): Promise<MachineRow> => {
    const label = nameOf(machineId);
    const status = await statusOf(machineId);
    const isSelf = machineId === d.selfMachineId();
    const step = desktopSetupStep(status, {
      label, frontMachineId: frontId() ?? machineId, frontLabel: d.selfLabel(),
      restarting: restarting(machineId), frontNotReady: !isSelf && !d.frontActive(),
      becomesFront: isSelf && !d.frontMachineId(), isPeer: !isSelf,
    });
    if (step.ready && !d.targetKey(machineId)) {
      return { machineId, label, state: 'identity-unverified', ready: false,
        title: `${label} is not verified yet`,
        detail: 'Its desktop works, but this machine does not hold its identity key, so it will not be offered. Ask your agent to re-pair it.',
        actions: [{ id: 'check', label: 'Check again' }] };
    }
    return { machineId, label, ...step };
  };

  /** A machine that is off must not found a second front. An unreachable peer
   *  cannot answer, so this narrows the race; the target's own check closes it. */
  const existingFront = async (): Promise<string | undefined> => {
    const statuses = await Promise.all(peerIds().map(statusOf));
    return statuses.find(status => status.frontMachineId)?.frontMachineId;
  };

  const peerIds = (): string[] => d.peers().map(peer => peer.machineId)
    .filter(id => id !== d.selfMachineId() && MACHINE_ID.test(id)).slice(0, MAX_PEERS);

  router.get('/desktop/setup', async (req, res) => {
    if (!guard(req, res)) return;
    const self = d.selfMachineId();
    if (!self) { res.status(503).json({ error: 'This machine has no identity yet, so Remote Desktop cannot run here.' }); return; }
    if (frontElsewhere()) {
      // This machine can still see and undo its own setup from here.
      const front = d.peers().find(peer => peer.machineId === d.frontMachineId());
      res.json({ frontElsewhere: true, frontLabel: front?.nickname?.slice(0, 80) || 'another machine', machines: [await rowFor(self)] });
      return;
    }
    const existing = d.frontMachineId() ? null : await existingFront();
    if (existing) {
      res.json({ frontElsewhere: true, frontLabel: nameOf(existing), machines: [] });
      return;
    }
    const machines = await Promise.all([self, ...peerIds()].map(rowFor));
    res.json({ frontElsewhere: false, frontLabel: d.selfLabel(), machines });
  });

  router.get('/desktop/setup/:machineId', async (req, res) => {
    if (!guard(req, res)) return;
    const id = req.params.machineId;
    if (id !== d.selfMachineId() && !peerIds().includes(id)) { res.status(404).json({ error: 'Unknown machine' }); return; }
    res.json(await rowFor(id));
  });

  // @write-domain:machine-local — each machine owns its own remoteDesktop config.
  router.post('/desktop/setup/:machineId', async (req, res) => {
    if (!guard(req, res)) return;
    if (req.headers['x-instar-request'] !== '1') { res.status(403).json({ error: 'X-Instar-Request: 1 required' }); return; }
    const id = req.params.machineId;
    const self = d.selfMachineId();
    if (!self || (id !== self && !peerIds().includes(id))) { res.status(404).json({ error: 'Unknown machine' }); return; }
    // A machine may always manage itself. Reaching another machine is the front's.
    if (frontElsewhere() && id !== self) { res.status(409).json({ error: 'front-elsewhere' }); return; }
    const front = frontId()!;
    const action = req.body?.action;
    const pane = req.body?.pane as DesktopSetupPane;
    let request: DesktopSetupRequest;
    if (action === 'turn-on') request = { action, frontMachineId: front };
    else if (action === 'turn-off' || action === 'show-prompt') request = { action };
    else if (action === 'open-settings' && (pane === 'screen' || pane === 'input')) request = { action, pane };
    else { res.status(400).json({ error: 'Unknown action' }); return; }
    if (action === 'turn-on' && !d.frontMachineId() && await existingFront()) {
      res.status(409).json({ error: 'front-elsewhere', step: await rowFor(id) }); return;
    }
    // Turn off works from a front that is itself already off.
    if (id !== self && !d.frontActive() && action !== 'turn-off') {
      res.status(409).json({ error: 'front-first', step: await rowFor(id) }); return;
    }
    try {
      let result: Record<string, unknown>;
      if (id === self) {
        const target = d.target();
        if (!target) { res.status(503).json({ error: 'Setup is unavailable on this machine' }); return; }
        result = await target.run(request, null);
      } else {
        result = await d.peerCall(id, { ...request });
      }
      if (result.restartRequested === true) restartRequestedAt.set(id, now());
      const step = await rowFor(id);
      res.json({ result: { accepted: true }, step: result.noticeFailed === true
        ? { ...step, note: 'The change is logged on that machine, but its notice could not be sent.' } : step });
    } catch (error) {
      const code = error instanceof DesktopSetupRefused ? error.code : (error as { code?: unknown }).code;
      const status = error instanceof DesktopSetupRefused ? error.httpStatus : (error as { status?: unknown }).status;
      res.status(typeof status === 'number' && status >= 400 && status < 600 ? status : 502).json({
        error: (typeof code === 'string' && REFUSAL_TEXT[code]) || 'That machine refused or did not answer.',
        ...(typeof code === 'string' && REFUSAL_TEXT[code] ? { code } : {}),
        step: await rowFor(id),
      });
    }
  });

  return router;
}

/** The body a peer may send to /api/desktop/setup, with the front taken from the
 * authenticated sender, never from a separate claim. */
export function parsePeerDesktopSetup(body: unknown, senderMachineId: string): DesktopSetupRequest | null {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (input.action === 'status' || input.action === 'show-prompt' || input.action === 'turn-off') return { action: input.action };
  if (input.action === 'turn-on') {
    return input.frontMachineId === senderMachineId ? { action: 'turn-on', frontMachineId: senderMachineId } : null;
  }
  if (input.action === 'open-settings' && (input.pane === 'screen' || input.pane === 'input')) {
    return { action: 'open-settings', pane: input.pane };
  }
  return null;
}

/** A peer's reply is read up to `limit` bytes and no further. */
export async function readBoundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('desktop-setup-reply-too-large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString('utf8');
}
