import { consolePathAllowed, createBrowserDevice, secureContextOk } from './browser-device.js';
import { canRenderStrictAction, needsContractHeaders } from './needs-actions.js';
import { createCredentialSheet } from './needs-credential-sheet.js';
import { mountNeedsStrip } from './needs-strip.js';

const credentialPath = (id) => '/mobile/needs/credentials/' + encodeURIComponent(id);
const requestIdPattern = /^[A-Za-z0-9_.:-]{1,200}$/;

export function mountBrowserCredentials(host, { bearer, machineId, createDevice = createBrowserDevice }) {
  const controller = new AbortController();
  const { signal } = controller;
  const device = createDevice({ bearer });
  let admitted = new Set();
  let sequence = 0;
  let stopStrip;
  const sheet = createCredentialSheet({
    signal,
    readDisclosure: (id) => device.call('GET', credentialPath(id), { signal }),
    submitConsent: (id, disclosureId, value) => device.call('POST', credentialPath(id), { json: { disclosureId, value }, signal }),
  });
  const credential = async (id, control) => {
    if (signal.aborted) return 'cancelled';
    if (!admitted.has(id)) return 'stale';
    const result = await sheet(id, control);
    if (result.kind === 'applied' || result.kind === 'stale') admitted.delete(id);
    return result.kind === 'applied' ? 'completed' : result.kind;
  };
  const signedAdapters = { credential };
  const get = async (path) => {
    const request = ++sequence;
    admitted = new Set();
    const result = await device.call('GET', '/mobile' + path, { headers: needsContractHeaders, signal });
    if (signal.aborted || request !== sequence) return { ok: false };
    if (!result.ok) return result;
    const { data } = result;
    if (data?.schemaVersion !== 2 || !Array.isArray(data.items) ||
      data.items.some(row => row?.action?.kind !== 'credential' || !requestIdPattern.test(row.action.requestId) ||
        !canRenderStrictAction(row, signedAdapters))) return { ok: false };
    admitted = new Set(data.items.map(row => row.action.requestId));
    return result;
  };
  const start = async () => {
    if (!consolePathAllowed(location.pathname) || !secureContextOk()) return;
    const status = await device.status(null);
    const currentMachine = status.data?.machineId;
    if (signal.aborted || !status.ok || !currentMachine || (machineId && currentMachine !== machineId)) return;
    const record = await device.load(currentMachine);
    if (signal.aborted || !record?.keyPair || !record.deviceId || record.status !== 'active') return;
    stopStrip = mountNeedsStrip(host, { get, signedAdapters, open: true, credentialOnly: true });
  };
  void start().catch(() => { /* @silent-fallback-ok: Without the stored browser key we cannot offer consent. */ });
  return () => {
    controller.abort();
    stopStrip?.();
    host.hidden = true;
    host.replaceChildren();
  };
}
