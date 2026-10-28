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
let waitTimer;
let lastMoveAt = 0;

function status(message) { $('status').textContent = message; }
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
  const digest = await crypto.subtle.digest('SHA-256', publicBytes);
  const fingerprint = [...new Uint8Array(digest)].slice(0, 16)
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const pinName = `instar_desktop_target_${machineId}`;
  const pinned = localStorage.getItem(pinName);
  if (pinned && pinned !== bytesToBase64(publicBytes)) throw new Error('Remote target key changed. Access refused.');
  if (!pinned) {
    const confirmed = window.confirm(`Compare this target fingerprint with the one in your private Telegram approval message:\n\n${fingerprint}\n\nDo they match exactly?`);
    if (!confirmed) throw new Error('Target fingerprint was not confirmed.');
    localStorage.setItem(pinName, bytesToBase64(publicBytes));
  }
}
function sendCommand(command) {
  sendChain = sendChain.then(async () => {
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
  if (sequence !== frameSequence + 1n) throw new Error('Remote frame sequence invalid.');
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
  if (waitTimer) clearTimeout(waitTimer);
  waitTimer = undefined;
  if (socket) { socket.close(); socket = undefined; }
  clearFrame();
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
    const targets = await api('/desktop/targets');
    $('machine').replaceChildren();
    for (const target of targets.machines || []) {
      const option = document.createElement('option');
      option.value = target.machineId;
      option.textContent = target.label;
      option.disabled = !target.ready;
      $('machine').append(option);
    }
    $('topic').replaceChildren();
    for (const topic of targets.topics || []) {
      const option = document.createElement('option');
      option.value = String(topic.topicId);
      option.textContent = topic.label;
      $('topic').append(option);
    }
    const preferredTopic = new URLSearchParams(location.search).get('topicId');
    if (preferredTopic && [...$('topic').options].some(option => option.value === preferredTopic)) $('topic').value = preferredTopic;
    $('unlock').hidden = true;
    $('request').hidden = false;
    status('Choose an available machine.');
  } catch (error) { status(error.message || 'Could not unlock.'); }
  finally { $('unlockButton').disabled = false; }
});

async function waitForApproval() {
  if (!requestId) return;
  try {
    const result = await api(`/desktop/requests/${encodeURIComponent(requestId)}`);
    if (result.status === 'approved') { await openStream(result); return; }
    if (result.status !== 'pending') { leave('The remote desktop request ended.'); return; }
    waitTimer = setTimeout(waitForApproval, 1000);
  } catch (error) { leave(error.message || 'Approval check failed.'); }
}

$('requestButton').addEventListener('click', async () => {
  if (!$('scope').checked) { status('Confirm full desktop control first.'); return; }
  $('requestButton').disabled = true;
  try {
    keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    ecdhKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const ecdhPublicKey = await crypto.subtle.exportKey('raw', ecdhKeyPair.publicKey);
    machineId = $('machine').value;
    const result = await api('/desktop/requests', 'POST', {
      machineId,
      topicId: Number($('topic').value),
      scopeConfirmed: true,
      browserPublicKey: bytesToBase64(publicKey),
      browserEcdhPublicKey: bytesToBase64(ecdhPublicKey),
      browserNonce: crypto.randomUUID().replaceAll('-', ''),
    });
    requestId = result.requestId;
    status('Waiting for your reply in Telegram…');
    waitTimer = setTimeout(waitForApproval, 1000);
  } catch (error) { status(error.message || 'Could not request access.'); }
  finally { $('requestButton').disabled = false; }
});

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
    $('request').hidden = true;
    $('control').hidden = false;
    $('machineName').textContent = ticket.label;
    status('Remote desktop is live.');
  });
  socket.addEventListener('message', event => {
    receiveChain = receiveChain.then(() => receiveFrame(event.data))
      .catch(() => leave('Encrypted remote display failed.'));
  });
  socket.addEventListener('close', () => leave('Remote desktop stopped.'));
  socket.addEventListener('error', () => leave('Remote desktop connection failed.'));
}

function send(action) {
  sendCommand({ type: 'input', action });
}
function position(event) {
  const rect = $('screen').getBoundingClientRect();
  const image = $('screen');
  if (!image.naturalWidth || !image.naturalHeight || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  return { x: Math.min(1, Math.max(0, (event.clientX - left) / width)),
    y: Math.min(1, Math.max(0, (event.clientY - top) / height)) };
}
$('screen').addEventListener('pointermove', event => {
  if (Date.now() - lastMoveAt < 80) return;
  lastMoveAt = Date.now();
  const at = position(event);
  if (at) send({ kind: 'move', ...at });
});
$('screen').addEventListener('click', event => { const at = position(event); if (at) send({ kind: 'click', ...at, button: 'left' }); });
$('screen').addEventListener('contextmenu', event => { event.preventDefault(); const at = position(event); if (at) send({ kind: 'click', ...at, button: 'right' }); });
$('typeButton').addEventListener('click', () => {
  const text = $('typeText').value;
  if (text) send({ kind: 'type', text });
  $('typeText').value = '';
});
$('stopButton').addEventListener('click', async () => {
  sendCommand({ type: 'stop' });
  let message = 'Remote desktop stopped.';
  try { await api(`/desktop/requests/${encodeURIComponent(requestId)}/revoke`, 'POST', {}); }
  catch { message = 'The viewer closed, but the target has not confirmed revocation. Access expires automatically.'; }
  leave(message);
});
window.addEventListener('beforeunload', () => {
  sendCommand({ type: 'stop' });
  clearFrame();
});
