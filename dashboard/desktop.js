// Remote-desktop viewer. Secrets and frames stay in memory only.
const $ = id => document.getElementById(id);
let token = '';
let operatorSession = '';
let keyPair;
let ecdhKeyPair;
let aesKey;
let inputSequence = 0n;
let frameSequence = 0n;
let sendChain = Promise.resolve();
let receiveChain = Promise.resolve();
let requestId = '';
let machineId = '';
let connectionNonce = '';
let socket;
let frameUrl = '';
let lastMoveAt = 0;
let pendingMove = null;
let moveFrame = 0;
let heartbeat = 0;
let inputEnabled = false;
let streamEpoch = 0;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let reconnectTimer = 0;
let resumeGeneration = 0;
let resumeAttempt = null;
let resumeSetupFailures = 0;
let resumeTransportFailures = 0;
const resumeControllers = new Set();
let stopping = false;
let trackpad = matchMedia('(pointer: coarse)').matches;
let cursor = { x: 0.5, y: 0.5 };
const pointers = new Map();
let heldButton = null;
let heldPhase = 'none';
let holdHeartbeat = 0;
let buttonOperationId = 0;
let nextKeyOperationId = 0;
const heldKeys = new Map();
const keyOperationIds = new Map();
const pendingKeyTaps = new Set();
const remoteKeys = new Set(['Meta', 'Control', 'Alt', 'Shift', 'Enter', 'Tab',
  'Escape', 'Backspace', 'Delete', 'Space', 'ArrowLeft', 'ArrowRight',
  'ArrowUp', 'ArrowDown', 'a', 'c', 'v', 'x', 'z']);

function syncHoldHeartbeat() {
  if (holdHeartbeat) { clearInterval(holdHeartbeat); holdHeartbeat = 0; }
  if (heldButton || heldKeys.size) {
    holdHeartbeat = setInterval(() => { if (inputEnabled) void sendCommand({ type: 'ping' }); }, 1_000);
  }
}

function setHeldButton(button, phase = button ? 'sent' : 'none') {
  if (!button) buttonOperationId++;
  heldButton = button;
  heldPhase = phase;
  syncHoldHeartbeat();
  $('dragButton').textContent = button ? 'Release' : 'Drag';
  $('dragButton').setAttribute('aria-pressed', String(!!button));
}
function flushPendingMove() {
  if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  if (pendingMove) { send({ kind: 'move', ...pendingMove }); pendingMove = null; }
}
function releaseButton() {
  if (!heldButton || heldPhase === 'releasing' || heldPhase === 'unknown') return;
  flushPendingMove();
  const button = heldButton;
  const epoch = streamEpoch;
  const streamSocket = socket;
  const operation = ++buttonOperationId;
  heldPhase = 'releasing';
  void send({ kind: 'buttonUp', ...cursor, button }).then(sent => {
    if (epoch !== streamEpoch || operation !== buttonOperationId
      || heldButton !== button || heldPhase !== 'releasing') return;
    if (sent) setHeldButton(null);
    else { heldPhase = 'unknown'; unexpectedDisconnect(streamSocket); }
  });
}
function beginHold(button) {
  if (heldButton) return;
  flushPendingMove();
  const epoch = streamEpoch;
  const streamSocket = socket;
  const operation = ++buttonOperationId;
  setHeldButton(button, 'pending');
  void send({ kind: 'buttonDown', ...cursor, button }).then(sent => {
    if (epoch !== streamEpoch || operation !== buttonOperationId
      || heldButton !== button || heldPhase !== 'pending') return;
    if (sent) heldPhase = 'sent';
    else { heldPhase = 'unknown'; unexpectedDisconnect(streamSocket); }
  });
}
function updateKeyButton(key) {
  for (const button of document.querySelectorAll('[data-remote-key]')) {
    if (button.dataset.remoteKey === key && button.dataset.modifier) {
      button.setAttribute('aria-pressed', String(heldKeys.has(key)));
    }
  }
}
function beginKey(key) {
  if (!inputEnabled || !remoteKeys.has(key) || heldKeys.has(key)) return Promise.resolve(false);
  heldKeys.set(key, 'pending');
  const epoch = streamEpoch;
  const streamSocket = socket;
  const operation = ++nextKeyOperationId;
  keyOperationIds.set(key, operation);
  updateKeyButton(key);
  syncHoldHeartbeat();
  return send({ kind: 'keyDown', key }).then(sent => {
    if (epoch !== streamEpoch || keyOperationIds.get(key) !== operation
      || heldKeys.get(key) !== 'pending') return false;
    if (sent) heldKeys.set(key, 'sent');
    else { heldKeys.set(key, 'unknown'); unexpectedDisconnect(streamSocket); }
    return sent;
  });
}
async function tapKey(key) {
  const epoch = streamEpoch;
  if (await beginKey(key) && epoch === streamEpoch) await releaseKey(key);
}
function releaseKey(key) {
  const phase = heldKeys.get(key);
  if (!phase || phase === 'releasing' || phase === 'unknown') return Promise.resolve(false);
  heldKeys.set(key, 'releasing');
  const epoch = streamEpoch;
  const streamSocket = socket;
  const operation = ++nextKeyOperationId;
  keyOperationIds.set(key, operation);
  return send({ kind: 'keyUp', key }).then(sent => {
    if (epoch !== streamEpoch || keyOperationIds.get(key) !== operation
      || heldKeys.get(key) !== 'releasing') return false;
    if (sent) { heldKeys.delete(key); keyOperationIds.delete(key); updateKeyButton(key); syncHoldHeartbeat(); }
    else { heldKeys.set(key, 'unknown'); unexpectedDisconnect(streamSocket); }
    return sent;
  });
}
function releaseControls() {
  releaseButton();
  for (const key of heldKeys.keys()) releaseKey(key);
}

function status(message) { $('status').textContent = message; $('liveStatus').textContent = message; }
const encoder = new TextEncoder();
const bytesToBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64ToBytes = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
function recordIv(direction, sequence) {
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  view.setUint32(0, direction === 'frame' ? 1 : 2);
  view.setBigUint64(4, sequence);
  return iv;
}
function recordAad(direction) {
  return encoder.encode(JSON.stringify(['instar-desktop-aead-v1', requestId, direction]));
}
async function deriveAesKey(targetPublic, salt) {
  const target = await crypto.subtle.importKey('raw', base64ToBytes(targetPublic),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: target }, ecdhKeyPair.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: base64ToBytes(salt),
    info: encoder.encode(`instar-desktop-aead-v1:${requestId}:${machineId}`) }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function verifyTarget(result) {
  if (result.machineId !== machineId || !Number.isSafeInteger(result.expiresAt)
    || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 10 * 60_000 + 2000) {
    throw new Error('Remote target identity or lease changed.');
  }
  const publicBytes = base64ToBytes(result.targetSigningPublicKey);
  const publicKey = await crypto.subtle.importKey('spki', publicBytes, 'Ed25519', false, ['verify']);
  const payload = encoder.encode(JSON.stringify(['desktop-target-key-v1', requestId, machineId,
    bytesToBase64(await crypto.subtle.exportKey('spki', keyPair.publicKey)),
    bytesToBase64(await crypto.subtle.exportKey('raw', ecdhKeyPair.publicKey)),
    result.targetEcdhPublicKey, result.salt, result.expiresAt]));
  const valid = await crypto.subtle.verify('Ed25519', publicKey,
    base64ToBytes(result.targetSignature), payload);
  if (!valid) throw new Error('Remote target signature did not verify.');
  const pinName = `instar_desktop_target_${machineId}`;
  const pinned = localStorage.getItem(pinName);
  if (pinned && pinned !== bytesToBase64(publicBytes)) throw new Error('Remote target key changed. Access refused.');
  if (!pinned) localStorage.setItem(pinName, bytesToBase64(publicBytes));
}
function sendCommand(command) {
  const epoch = streamEpoch;
  sendChain = sendChain.then(async () => {
    if (epoch !== streamEpoch) return false;
    if (!inputEnabled && command.type === 'input') return false;
    if (socket?.readyState !== WebSocket.OPEN || !aesKey) return false;
    const sequence = ++inputSequence;
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM',
      iv: recordIv('input', sequence), additionalData: recordAad('input') }, aesKey,
    encoder.encode(JSON.stringify(command))));
    const record = new Uint8Array(8 + ciphertext.length);
    new DataView(record.buffer).setBigUint64(0, sequence);
    record.set(ciphertext, 8);
    if (epoch !== streamEpoch || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(record);
    return true;
  }).catch(() => { if (epoch === streamEpoch) leave('Encrypted remote input failed.'); return false; });
  return sendChain;
}
async function receiveFrame(recordBuffer, epoch) {
  if (!inputEnabled || epoch !== streamEpoch) return;
  if (!aesKey || !(recordBuffer instanceof ArrayBuffer) || recordBuffer.byteLength < 28
    || recordBuffer.byteLength > 1_000_024) throw new Error('Encrypted frame invalid.');
  const record = new Uint8Array(recordBuffer);
  const sequence = new DataView(recordBuffer).getBigUint64(0);
  // The target may drop an already-encrypted frame under backpressure. A
  // strictly increasing nonce still rejects replay/reordering without treating
  // an intentional video drop as a broken session.
  if (sequence <= frameSequence) throw new Error('Remote frame sequence invalid.');
  const frame = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: recordIv('frame', sequence),
    additionalData: recordAad('frame') }, aesKey, record.subarray(8));
  if (!inputEnabled || epoch !== streamEpoch) return;
  frameSequence = sequence;
  const old = frameUrl;
  frameUrl = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
  $('screen').src = frameUrl;
  if (old) URL.revokeObjectURL(old);
}
function clearFrame() {
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frameUrl = '';
  $('screen').removeAttribute('src');
}
function leave(message) {
  streamEpoch++;
  inputEnabled = false;
  if (socket) { socket.close(); socket = undefined; }
  if (heartbeat) { clearInterval(heartbeat); heartbeat = 0; }
  if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  pendingMove = null;
  pointers.clear();
  setHeldButton(null);
  for (const key of heldKeys.keys()) { heldKeys.delete(key); keyOperationIds.delete(key); updateKeyButton(key); }
  pendingKeyTaps.clear();
  syncHoldHeartbeat();
  clearFrame();
  document.body.classList.remove('desktop-live', 'trackpad');
  $('control').hidden = true;
  if (token) $('request').hidden = false;
  status(message);
}
function unexpectedDisconnect(streamSocket) {
  if (socket !== streamSocket || stopping) return;
  leave('Connection interrupted. Checking whether access can resume…');
  if (!token || !operatorSession || !requestId) return;
  // Stop remains reachable while the target decides whether this interruption
  // may resume. The browser cannot create a new grant on its own.
  $('request').hidden = true;
  $('control').hidden = false;
  document.body.classList.add('desktop-live');
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    status('Connection interrupted. Stop access, then open the desktop again.');
    return;
  }
  const generation = ++resumeGeneration;
  resumeSetupFailures = 0;
  resumeTransportFailures = 0;
  scheduleResume(generation, 500);
}
function scheduleResume(generation, delay) {
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    if (!stopping && generation === resumeGeneration) void resumeDesktop(generation);
  }, delay);
}
function abortResumeRequests() {
  for (const controller of resumeControllers) controller.abort();
  resumeControllers.clear();
}
async function resumeApi(path, method = 'GET', body) {
  const controller = new AbortController();
  resumeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 5_000);
  try { return await api(path, method, body, controller.signal); }
  finally { clearTimeout(timer); resumeControllers.delete(controller); }
}
async function resumeDesktop(generation) {
  const current = () => !stopping && generation === resumeGeneration && !!requestId;
  if (!current()) return;
  let activated = false;
  try {
    const state = await resumeApi(`/desktop/requests/${encodeURIComponent(requestId)}`);
    if (!current()) return;
    if (state.status === 'revoked') throw Object.assign(new Error('Desktop access ended. Open it again when needed.'), { terminal: true });
    if (state.status === 'approved') {
      if (resumeAttempt?.generation === generation && state.connectionNonce !== resumeAttempt.body.previousConnectionNonce) {
        resumeAttempt.approved = true;
        activated = true;
        await openStream(state, generation);
        return;
      }
    }
    if (state.status !== 'interrupted' && state.status !== 'approved') throw Object.assign(new Error('Desktop access cannot resume.'), { terminal: true });
    if (resumeAttempt?.approved) resumeAttempt = null;
    if (!resumeAttempt) {
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) throw Object.assign(new Error('Connection interrupted. Open the desktop again.'), { terminal: true });
      reconnectAttempts++;
      const previousKeyPair = keyPair;
      const previousConnectionNonce = connectionNonce;
      if (!previousKeyPair || !previousConnectionNonce || (state.status === 'approved'
        && state.connectionNonce !== previousConnectionNonce)) throw Object.assign(
          new Error('Desktop connection identity changed.'), { terminal: true });
      keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      ecdhKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      if (!current()) return;
      const publicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
      const ecdhPublicKey = await crypto.subtle.exportKey('raw', ecdhKeyPair.publicKey);
      const attemptId = crypto.randomUUID().replaceAll('-', '');
      const browserNonce = crypto.randomUUID().replaceAll('-', '');
      const browserPublicKey = bytesToBase64(publicKey);
      const browserEcdhPublicKey = bytesToBase64(ecdhPublicKey);
      const proof = await crypto.subtle.sign('Ed25519', previousKeyPair.privateKey,
        encoder.encode(JSON.stringify(['desktop-resume-v1', requestId, previousConnectionNonce,
          attemptId, browserPublicKey, browserEcdhPublicKey, browserNonce])));
      if (!current()) return;
      resumeAttempt = { generation, approved: false, body: {
        attemptId, previousConnectionNonce, previousSignature: bytesToBase64(proof),
        browserPublicKey, browserEcdhPublicKey, browserNonce,
      } };
    }
    const resumeBody = resumeAttempt.body;
    let approved;
    for (let retry = 0; retry < 3 && current(); retry++) {
      try {
        approved = await resumeApi(`/desktop/requests/${encodeURIComponent(requestId)}/resume`, 'POST', resumeBody);
        break;
      } catch (error) {
        if (!current()) return;
        if (error.httpStatus === 403) throw error;
        // A lost HTTP response may follow a successful server activation.
        const observed = await resumeApi(`/desktop/requests/${encodeURIComponent(requestId)}`);
        if (observed.status === 'approved' && observed.connectionNonce !== resumeBody.previousConnectionNonce) {
          approved = observed; break;
        }
        if (observed.status !== 'interrupted' && observed.status !== 'approved') throw Object.assign(error, { terminal: true });
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** retry));
      }
    }
    if (!current()) return;
    if (!approved || approved.status !== 'approved') throw new Error('Desktop access could not resume.');
    resumeAttempt.approved = true;
    activated = true;
    await openStream(approved, generation);
  } catch (error) {
    if (!current()) return;
    if (activated && (error.transportFailure || error.transportSetup || error.httpStatus === 403)
      && ++resumeSetupFailures <= 3) {
      scheduleResume(generation, 500 * resumeSetupFailures);
      return;
    }
    // Only a temporary transport read failure may be retried. A target refusal
    // or expired PIN session is terminal for this automatic path.
    if (!activated && !error.httpStatus && !error.terminal && ++resumeTransportFailures <= 3) {
      scheduleResume(generation, 500 * 2 ** (resumeTransportFailures - 1));
      return;
    }
    resumeAttempt = null;
    leave(error.message || 'Desktop access cannot resume.');
  }
}
async function api(path, method = 'GET', body, signal) {
  let response;
  try { response = await fetch(path, {
    method, cache: 'no-store', credentials: 'same-origin',
    ...(signal ? { signal } : {}),
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Instar-Operator-Session': operatorSession,
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Instar-Request': '1' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }); } catch (error) {
    if (signal) error.transportFailure = true;
    throw error;
  }
  let result;
  try { result = await response.json(); }
  catch (error) {
    if (signal && (error.name === 'AbortError' || error instanceof TypeError)) {
      error.transportFailure = true;
      throw error;
    }
    if (signal) throw error;
    result = {};
  }
  if (!response.ok) {
    const error = new Error(result.error || `Server answered ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return result;
}

function requirePinAgain() {
  token = '';
  operatorSession = '';
  $('retryButton').hidden = true;
  $('request').hidden = true;
  $('unlock').hidden = false;
  status('Your dashboard session ended. Enter your PIN again.');
}

async function loadTargetsAndMaybeOpen() {
  const targets = await api('/desktop/targets');
  $('machine').replaceChildren();
  for (const target of targets.machines || []) {
    const option = document.createElement('option');
    option.value = target.machineId;
    option.textContent = target.label;
    option.disabled = !target.ready;
    $('machine').append(option);
  }
  const preferredMachine = new URLSearchParams(location.search).get('machineId');
  const hasPreferredMachine = !!preferredMachine && [...$('machine').options]
    .some(option => option.value === preferredMachine && !option.disabled);
  if (hasPreferredMachine) $('machine').value = preferredMachine;
  $('unlock').hidden = true;
  const ready = [...$('machine').options].filter(option => !option.disabled);
  if (ready.length === 0) {
    $('request').hidden = true;
    $('retryButton').hidden = false;
    const reason = (targets.machines || []).find(target => target.unavailableReason)?.unavailableReason;
    status(reason || 'This machine’s desktop is not available right now.');
    return;
  }
  $('retryButton').hidden = true;
  if (ready.length === 1 || hasPreferredMachine) {
    if (ready.length === 1) $('machine').value = ready[0].value;
    status(`Opening ${$('machine').selectedOptions[0].textContent}…`);
    await requestDesktop();
  } else {
    $('request').hidden = false;
    status('Choose a machine to open.');
  }
}

$('unlockButton').addEventListener('click', async () => {
  $('unlockButton').disabled = true;
  try {
    const response = await fetch('/dashboard/unlock', {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: $('pin').value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.token || !result.operatorSessionToken) {
      throw new Error(result.error || 'Dashboard PIN was not accepted.');
    }
    token = result.token;
    operatorSession = result.operatorSessionToken;
    $('pin').value = '';
    await loadTargetsAndMaybeOpen();
  } catch (error) {
    if (/dashboard operator session|dashboard PIN session/i.test(error.message || '')) requirePinAgain();
    else status(error.message || 'Could not unlock.');
  }
  finally { $('unlockButton').disabled = false; }
});

$('retryButton').addEventListener('click', async () => {
  $('retryButton').disabled = true;
  try { await loadTargetsAndMaybeOpen(); }
  catch (error) {
    if (/dashboard operator session|dashboard PIN session/i.test(error.message || '')) requirePinAgain();
    else status(error.message || 'Could not check this machine.');
  } finally { $('retryButton').disabled = false; }
});

async function requestDesktop() {
  reconnectAttempts = 0;
  resumeTransportFailures = 0;
  stopping = false;
  resumeGeneration++;
  resumeAttempt = null;
  abortResumeRequests();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  $('requestButton').disabled = true;
  const previousRequestId = requestId;
  requestId = '';
  try {
    if (previousRequestId) {
      // A lost WebSocket can remain half-open at the target. Revoke it before
      // seeking a fresh grant; the target's controller lock also fences overlap.
      try { await api(`/desktop/requests/${encodeURIComponent(previousRequestId)}/revoke`, 'POST', {}); }
      catch { /* A stale or unreachable grant is still fenced by the controller lock. */ }
    }
    keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    ecdhKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const ecdhPublicKey = await crypto.subtle.exportKey('raw', ecdhKeyPair.publicKey);
    machineId = $('machine').value;
    const result = await api('/desktop/requests', 'POST', {
      machineId,
      browserPublicKey: bytesToBase64(publicKey),
      browserEcdhPublicKey: bytesToBase64(ecdhPublicKey),
      browserNonce: crypto.randomUUID().replaceAll('-', ''),
    });
    requestId = result.requestId;
    const approved = await api(`/desktop/requests/${encodeURIComponent(requestId)}`);
    if (approved.status !== 'approved') throw new Error('Desktop access was not granted.');
    try {
      const point = await api(`/desktop/requests/${encodeURIComponent(requestId)}/cursor`);
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) cursor = point;
    } catch { /* A missing cursor readback cannot grant input or bypass host checks. */ }
    await openStream(approved);
  } catch (error) {
    if (requestId) {
      try { await api(`/desktop/requests/${encodeURIComponent(requestId)}/revoke`, 'POST', {}); }
      catch { /* The lease and idle limit still fence access if the revoke request fails. */ }
      requestId = '';
    }
    const message = error.message || 'Could not open desktop.';
    if (/dashboard operator session|dashboard PIN session/i.test(message)) {
      requirePinAgain();
    } else {
      $('request').hidden = false;
      status(message);
    }
  }
  finally { $('requestButton').disabled = false; }
}
$('requestButton').addEventListener('click', requestDesktop);

async function openStream(result, resume = null) {
  await verifyTarget(result);
  if (stopping || (resume !== null && resume !== resumeGeneration)) return;
  // Keep the verified key and grant generation together even if the WebSocket
  // upgrade never reaches its open event. A later target interruption must be
  // signed by this generation, not by the already-replaced predecessor.
  connectionNonce = result.connectionNonce;
  aesKey = await deriveAesKey(result.targetEcdhPublicKey, result.salt);
  if (stopping || (resume !== null && resume !== resumeGeneration)) return;
  inputSequence = 0n;
  frameSequence = 0n;
  const payload = new TextEncoder().encode(JSON.stringify(['desktop-browser-possession-v1', requestId, result.connectionNonce]));
  const proof = await crypto.subtle.sign('Ed25519', keyPair.privateKey, payload);
  const ticket = await (resume === null ? api : resumeApi)(`/desktop/requests/${encodeURIComponent(requestId)}/ticket`, 'POST', {
    connectionNonce: result.connectionNonce,
    signature: bytesToBase64(proof),
  });
  if (stopping || (resume !== null && resume !== resumeGeneration)) return;
  if (ticket.machineId !== machineId || typeof ticket.ticket !== 'string') throw new Error('Target identity changed.');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}/desktop-stream`,
    ['instar-desktop-v1', `ticket.${ticket.ticket}`]);
  const streamSocket = socket;
  const epoch = ++streamEpoch;
  sendChain = Promise.resolve();
  receiveChain = Promise.resolve();
  socket.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
  let opened = false;
  let settled = false;
  const failSetup = () => {
    if (settled || opened) return;
    settled = true;
    clearTimeout(setupTimer);
    reject(Object.assign(new Error('Remote desktop connection could not open.'), { transportSetup: true }));
  };
  const setupTimer = setTimeout(() => {
    if (!opened) { try { streamSocket.close(); } catch { /* close may already be in flight */ } }
    failSetup();
  }, 5_000);
  socket.addEventListener('open', () => {
    if (socket !== streamSocket || stopping || (resume !== null && resume !== resumeGeneration)) {
      streamSocket.close(); failSetup(); return;
    }
    opened = true;
    settled = true;
    clearTimeout(setupTimer);
    inputEnabled = true;
    $('request').hidden = true;
    $('control').hidden = false;
    document.body.classList.add('desktop-live');
    document.body.classList.toggle('trackpad', trackpad);
    $('modeButton').textContent = trackpad ? 'Trackpad' : 'Direct';
    $('modeButton').setAttribute('aria-pressed', String(trackpad));
    updateCursor();
    $('machineName').textContent = ticket.label;
    status('Remote desktop is live.');
    if (resume !== null) resumeAttempt = null;
    resumeTransportFailures = 0;
    heartbeat = setInterval(() => {
      sendCommand({ type: 'ping' });
    }, 30_000);
    resolve();
  });
  socket.addEventListener('message', event => {
    if (socket !== streamSocket || epoch !== streamEpoch) return;
    receiveChain = receiveChain.then(() => receiveFrame(event.data, epoch))
      .catch(() => { if (socket === streamSocket && epoch === streamEpoch) leave('Encrypted remote display failed.'); });
  });
  socket.addEventListener('close', () => {
    if (!opened) { failSetup(); return; }
    unexpectedDisconnect(streamSocket);
  });
  socket.addEventListener('error', () => {
    if (!opened) { failSetup(); return; }
    unexpectedDisconnect(streamSocket);
  });
  });
}

function send(action) {
  if (!inputEnabled) return Promise.resolve(false);
  return sendCommand({ type: 'input', action });
}
function imageArea() {
  const rect = $('screen').getBoundingClientRect();
  const image = $('screen');
  if (!image.naturalWidth || !image.naturalHeight || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  return { left, top, width, height };
}
function clamp(value) { return Math.min(1, Math.max(0, value)); }
function position(event) {
  const area = imageArea();
  return area ? { x: clamp((event.clientX - area.left) / area.width),
    y: clamp((event.clientY - area.top) / area.height) } : null;
}
function updateCursor() {
  const area = imageArea();
  if (!area) return;
  const rect = $('surface').getBoundingClientRect();
  $('localCursor').style.left = `${area.left - rect.left + cursor.x * area.width}px`;
  $('localCursor').style.top = `${area.top - rect.top + cursor.y * area.height}px`;
}
function queueMove(at) {
  pendingMove = at;
  if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
}
function flushMove(time) {
  if (time - lastMoveAt < 33) { moveFrame = requestAnimationFrame(flushMove); return; }
  moveFrame = 0;
  lastMoveAt = time;
  if (pendingMove) { send({ kind: 'move', ...pendingMove }); pendingMove = null; }
}
function moveCursor(dx, dy) {
  const area = imageArea();
  if (!area) return;
  cursor = { x: clamp(cursor.x + dx * 1.3 / area.width),
    y: clamp(cursor.y + dy * 1.3 / area.height) };
  updateCursor();
  queueMove(cursor);
}
function clickCursor(button = 'left') { if (!heldButton) send({ kind: 'click', ...cursor, button }); }
$('modeButton').addEventListener('click', () => {
  releaseButton();
  trackpad = !trackpad;
  pointers.clear();
  document.body.classList.toggle('trackpad', trackpad);
  $('modeButton').textContent = trackpad ? 'Trackpad' : 'Direct';
  $('modeButton').setAttribute('aria-pressed', String(trackpad));
});
$('dragButton').addEventListener('click', () => {
  if (heldButton) { releaseButton(); return; }
  beginHold('left');
});
$('rightButton').addEventListener('click', () => clickCursor('right'));
for (const button of document.querySelectorAll('[data-remote-key]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.remoteKey;
    if (button.dataset.modifier) {
      if (heldKeys.has(key)) {
        const epoch = streamEpoch;
        void Promise.all([...pendingKeyTaps]).then(() => {
          if (epoch === streamEpoch) return releaseKey(key);
        });
      }
      else beginKey(key);
    } else {
      const tap = tapKey(key);
      pendingKeyTaps.add(tap);
      void tap.finally(() => pendingKeyTaps.delete(tap));
    }
  });
}
function eventKey(event) {
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return remoteKeys.has(key) ? key : null;
}
document.addEventListener('keydown', event => {
  if (!inputEnabled || event.target instanceof HTMLInputElement) return;
  const key = eventKey(event);
  if (!key) return;
  event.preventDefault();
  if (!event.repeat) beginKey(key);
});
document.addEventListener('keyup', event => {
  if (!inputEnabled || event.target instanceof HTMLInputElement) return;
  const key = eventKey(event);
  if (!key) return;
  event.preventDefault();
  releaseKey(key);
});
$('surface').addEventListener('contextmenu', event => event.preventDefault());
$('surface').addEventListener('pointerdown', event => {
  event.preventDefault();
  $('surface').setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY,
    startX: event.clientX, startY: event.clientY, maxDistance: 0,
    at: Date.now(), multi: pointers.size > 0 });
  if (pointers.size > 1) for (const state of pointers.values()) state.multi = true;
  if (!trackpad || event.pointerType === 'mouse') {
    const at = position(event);
    if (at) { cursor = at; updateCursor(); queueMove(at); }
    if (event.pointerType === 'mouse' && at && !heldButton) beginHold(event.button === 2 ? 'right' : 'left');
  }
});
$('surface').addEventListener('pointermove', event => {
  const state = pointers.get(event.pointerId);
  if (!state) {
    if (event.pointerType === 'mouse') { const at = position(event); if (at) { cursor = at; updateCursor(); queueMove(at); } }
    return;
  }
  event.preventDefault();
  const dx = event.clientX - state.x, dy = event.clientY - state.y;
  state.x = event.clientX; state.y = event.clientY;
  state.maxDistance = Math.max(state.maxDistance,
    Math.hypot(event.clientX - state.startX, event.clientY - state.startY));
  if (pointers.size > 1 && event.pointerType !== 'mouse') {
    if (dx || dy) send({ kind: 'scroll', dx: Math.max(-200, Math.min(200, dx * 1.5)),
      dy: Math.max(-200, Math.min(200, dy * 1.5)) });
  } else if (state.multi && event.pointerType !== 'mouse') {
    // Do not turn the trailing finger of a scroll gesture into pointer motion.
  } else if (trackpad && event.pointerType !== 'mouse') moveCursor(dx, dy);
  else { const at = position(event); if (at) { cursor = at; queueMove(at); } }
});
$('surface').addEventListener('pointerup', event => {
  const state = pointers.get(event.pointerId);
  if (!state) return;
  event.preventDefault();
  pointers.delete(event.pointerId);
  if (event.pointerType === 'mouse' && heldButton) {
    const at = position(event);
    if (at) { cursor = at; queueMove(at); }
    releaseButton();
    return;
  }
  const distance = Math.max(state.maxDistance,
    Math.hypot(event.clientX - state.startX, event.clientY - state.startY));
  if (!state.multi && distance < 10 && Date.now() - state.at < 500) {
    if (!trackpad || event.pointerType === 'mouse') { const at = position(event); if (at) cursor = at; }
    clickCursor(event.button === 2 ? 'right' : 'left');
  }
});
function cancelGestures() { pointers.clear(); releaseControls(); }
$('surface').addEventListener('pointercancel', cancelGestures);
window.addEventListener('blur', cancelGestures);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelGestures(); });
window.addEventListener('resize', updateCursor);
$('screen').addEventListener('load', updateCursor);
$('typeButton').addEventListener('click', () => {
  const text = $('typeText').value;
  if (text) { releaseControls(); send({ kind: 'type', text }); }
  $('typeText').value = '';
});
$('typeText').addEventListener('focus', releaseControls);
$('stopButton').addEventListener('click', async () => {
  stopping = true;
  resumeGeneration++;
  resumeAttempt = null;
  abortResumeRequests();
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  inputEnabled = false;
  if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  pendingMove = null;
  pointers.clear();
  setHeldButton(null);
  for (const key of heldKeys.keys()) { heldKeys.delete(key); keyOperationIds.delete(key); updateKeyButton(key); }
  pendingKeyTaps.clear();
  syncHoldHeartbeat();
  sendCommand({ type: 'stop' });
  const stoppingRequestId = requestId;
  // Blank the viewer immediately, even when the revoke HTTP request is slow.
  // Input was disabled above; late video frames are ignored by receiveFrame.
  clearFrame();
  $('control').hidden = true;
  status('Stopping remote desktop…');
  let message = 'Remote desktop stopped.';
  try { await api(`/desktop/requests/${encodeURIComponent(stoppingRequestId)}/revoke`, 'POST', {}); }
  catch { message = 'The viewer closed, but the target has not confirmed revocation. Access expires automatically.'; }
  leave(message);
});
window.addEventListener('beforeunload', () => {
  stopping = true;
  sendCommand({ type: 'stop' });
  clearFrame();
});
