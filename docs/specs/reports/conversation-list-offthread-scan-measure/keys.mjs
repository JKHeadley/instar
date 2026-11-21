import crypto from 'node:crypto'; import fs from 'node:fs';
const dir = process.argv[2]; fs.mkdirSync(`${dir}/app`, { recursive: true, mode: 0o700 });
const { privateKey: k } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
fs.writeFileSync(`${dir}/device.pem`, k.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const j = k.export({ format: 'jwk' });
fs.writeFileSync(`${dir}/public.txt`, Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url'));
fs.writeFileSync(`${dir}/app/io.sagemindai.instar.device.50A0C000-0000-4000-8000-000000003598.key`, Buffer.from(j.d, 'base64url'), { mode: 0o600 });
