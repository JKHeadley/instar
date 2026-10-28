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
let socket;
let frameUrl = '';
let lastMoveAt = 0;
let pendingMove = null;
let moveFrame = 0;
let heartbeat = 0;
let inputEnabled = false;
let trackpad = matchMedia('(pointer: coarse)').matches;
let cursor = { x: 0.5, y: 0.5 };
const pointers = new Map();

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
  sendChain = sendChain.then(async () => {
    if (!inputEnabled && command.type === 'input') return;
    if (socket?.readyState !== WebSocket.OPEN || !aesKey) return;
    const sequence = ++inputSequence;
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM',
      iv: recordIv('input', sequence), additionalData: recordAad('input') }, aesKey,
    encoder.encode(JSON.stringify(command))));
    const record = new Uint8Array(8 + ciphertext.length);
    new DataView(record.buffer).setBigUint64(0, sequence);
    record.set(ciphertext, 8);
    socket.send(record);
  }).catch(() => leave('Encrypted remote input failed.'));
}
async function receiveFrame(recordBuffer) {
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
  inputEnabled = false;
  if (socket) { socket.close(); socket = undefined; }
  if (heartbeat) { clearInterval(heartbeat); heartbeat = 0; }
  if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  pendingMove = null;
  pointers.clear();
  clearFrame();
  document.body.classList.remove('desktop-live', 'trackpad');
  $('control').hidden = true;
  if (token) $('request').hidden = false;
  status(message);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method, cache: 'no-store', credentials: 'same-origin',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Instar-Operator-Session': operatorSession,
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Instar-Request': '1' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Server answered ${response.status}`);
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
  $('requestButton').disabled = true;
  requestId = '';
  try {
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

async function openStream(result) {
  await verifyTarget(result);
  aesKey = await deriveAesKey(result.targetEcdhPublicKey, result.salt);
  inputSequence = 0n;
  frameSequence = 0n;
  const payload = new TextEncoder().encode(JSON.stringify(['desktop-browser-possession-v1', requestId, result.connectionNonce]));
  const proof = await crypto.subtle.sign('Ed25519', keyPair.privateKey, payload);
  const ticket = await api(`/desktop/requests/${encodeURIComponent(requestId)}/ticket`, 'POST', {
    connectionNonce: result.connectionNonce,
    signature: bytesToBase64(proof),
  });
  if (ticket.machineId !== machineId || typeof ticket.ticket !== 'string') throw new Error('Target identity changed.');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}/desktop-stream`,
    ['instar-desktop-v1', `ticket.${ticket.ticket}`]);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
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
    heartbeat = setInterval(() => sendCommand({ type: 'ping' }), 30_000);
  });
  socket.addEventListener('message', event => {
    receiveChain = receiveChain.then(() => receiveFrame(event.data))
      .catch(() => leave('Encrypted remote display failed.'));
  });
  const streamSocket = socket;
  socket.addEventListener('close', () => {
    if (socket === streamSocket) leave('Connection interrupted. Open the desktop again.');
  });
  socket.addEventListener('error', () => {
    if (socket === streamSocket) leave('Remote desktop connection failed.');
  });
}

function send(action) {
  if (!inputEnabled) return;
  sendCommand({ type: 'input', action });
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
function clickCursor(button = 'left') { send({ kind: 'click', ...cursor, button }); }
$('modeButton').addEventListener('click', () => {
  trackpad = !trackpad;
  pointers.clear();
  document.body.classList.toggle('trackpad', trackpad);
  $('modeButton').textContent = trackpad ? 'Trackpad' : 'Direct';
  $('modeButton').setAttribute('aria-pressed', String(trackpad));
});
$('rightButton').addEventListener('click', () => clickCursor('right'));
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
  const distance = Math.max(state.maxDistance,
    Math.hypot(event.clientX - state.startX, event.clientY - state.startY));
  if (!state.multi && distance < 10 && Date.now() - state.at < 500) {
    if (!trackpad || event.pointerType === 'mouse') { const at = position(event); if (at) cursor = at; }
    clickCursor(event.button === 2 ? 'right' : 'left');
  }
});
$('surface').addEventListener('pointercancel', event => { pointers.delete(event.pointerId); });
window.addEventListener('resize', updateCursor);
$('screen').addEventListener('load', updateCursor);
$('typeButton').addEventListener('click', () => {
  const text = $('typeText').value;
  if (text) send({ kind: 'type', text });
  $('typeText').value = '';
});
$('stopButton').addEventListener('click', async () => {
  inputEnabled = false;
  if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  pendingMove = null;
  pointers.clear();
  sendCommand({ type: 'stop' });
  const stoppingRequestId = requestId;
  status('Stopping remote desktop…');
  let message = 'Remote desktop stopped.';
  try { await api(`/desktop/requests/${encodeURIComponent(stoppingRequestId)}/revoke`, 'POST', {}); }
  catch { message = 'The viewer closed, but the target has not confirmed revocation. Access expires automatically.'; }
  leave(message);
});
window.addEventListener('beforeunload', () => {
  sendCommand({ type: 'stop' });
  clearFrame();
});
