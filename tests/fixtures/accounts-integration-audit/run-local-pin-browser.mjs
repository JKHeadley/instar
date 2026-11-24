import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [playwrightEntry, sourceDir, output] = process.argv.slice(2);
if (!playwrightEntry || !sourceDir) throw Error('Pass a Playwright index.mjs path and a prepared source directory');
const { chromium } = await import(pathToFileURL(resolve(playwrightEntry)).href);
const expected = JSON.parse(readFileSync(join(here,'local-pin-browser-receipt.json'), 'utf8'));
const { accounts, identity, base } = expected;
const source = new Map([['fixture.mjs', readFileSync(join(here,'local-pin-browser-fixture.mjs'))]]);
for (const [file,digest] of Object.entries(expected.fixturePaths)) {
  const bytes = readFileSync(join(resolve(sourceDir),file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `Unexpected source bytes for ${file}`);
  source.set(file,bytes);
}
const accessed = new Set();
let port;
const server = createServer((req,res) => {
  const path = new URL(req.url,`http://127.0.0.1:${port}`).pathname.slice(1);
  if (!path) {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    return res.end('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><main></main><script type="module" src="/fixture.mjs"></script>');
  }
  if (req.method !== 'GET' || !source.has(path)) {
    res.writeHead(404);
    return res.end();
  }
  accessed.add(path);
  res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});
  res.end(source.get(path));
});

const challenge = '/local-access/v1/use-challenge';
const unlock = '/dashboard/unlock';
const configure = '/subscription-relogin/configure-pool';
const fixtureChallenge = 'invented-challenge';
const unlockResponse = {operatorSessionToken:'invented-operator-session',operatorSessionExpiresAt: new Date(Date.now()+120_000).toISOString()};
const results = [];
const errors = [];
let browser;
try {
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({headless:true,args:['--disable-background-networking']});
  for (const test of ['leave-during-challenge','leave-during-unlock','stay-current']) {
    const context = await browser.newContext({serviceWorkers:'block'});
    try {
      await context.route('**/*', route => route.request().url().startsWith(origin+'/') ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on('pageerror',error => errors.push(error.message));
      await page.goto(origin, {waitUntil:'domcontentloaded'});
      await page.waitForFunction(() => Boolean(window.pinFixture));
      await page.getByRole('checkbox',{name:'Include Fixture Studio'}).check();
      await page.getByRole('button',{name:'Turn on for ticked machines'}).click();
      await page.getByRole('textbox',{name:'Dashboard PIN'}).fill('000000');
      await page.getByRole('button',{name:'Continue', exact:true}).click();
      await page.waitForFunction(path => window.pinFixture.waiting(path),challenge);
      if (test==='leave-during-challenge') assert.equal(await page.evaluate(() => window.pinFixture.leave()),true);
      await page.evaluate(([path,data]) => window.pinFixture.release(path,data),[challenge,{challenge:fixtureChallenge}]);
      await page.waitForFunction(path => window.pinFixture.waiting(path),unlock);
      if (test==='leave-during-unlock') assert.equal(await page.evaluate(() => window.pinFixture.leave()),true);

      const capture = await page.evaluate(() => ({calls:window.pinFixture.calls,publicData:window.pinFixture.publicData}));
      const publicData = capture.publicData;
      const challenged = capture.calls.find(call => call.path===challenge);
      assert.deepEqual(challenged,{path:challenge,method:'POST',credentials:'omit',body:{credentialId:publicData.credentialId,action:'dashboard-unlock'}});
      const submitted = capture.calls.find(call => call.path===unlock);
      assert.equal(submitted.method,'POST');
      assert.equal(submitted.credentials,'same-origin');
      assert.equal(submitted.body.pin,'000000');
      const localProof = submitted.body.localAccess;
      assert.equal(localProof?.credentialId,publicData.credentialId);
      assert.equal(localProof?.challenge,fixtureChallenge);
      const canonical = ['instar-local-use-v1',publicData.agentName,publicData.credentialId,'dashboard-unlock',fixtureChallenge,publicData.origin,'POST /dashboard/unlock'].join('\n');
      assert.equal(verify('sha256',Buffer.from(canonical),createPublicKey({key:publicData.publicJwk,format:'jwk'}),Buffer.from(localProof.signature,'base64url')),true);

      await page.evaluate(([path,data]) => window.pinFixture.release(path,data),[unlock,unlockResponse]);
      if (test==='stay-current') {
        await page.getByText('Done.',{exact:true}).waitFor();
      } else {
        // Yield one browser task following fulfillment of the local mocked fetch.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve,0)));
      }
      const final = await page.evaluate(() => ({
        dialog: document.querySelector('.sheet-title')?.textContent,
        page: document.querySelector('main')?.textContent,
        calls: window.pinFixture.calls.map(call => call.path),
        sessionPresent: window.pinFixture.sessionPresent(),
      }));
      if (test==='stay-current') {
        assert.equal(final.dialog,'Turn on automatic sign-in repair');
        assert.deepEqual(final.calls,['/dashboard/unlock-check',challenge,unlock,configure]);
        assert.equal(final.sessionPresent,true);
      } else {
        assert.equal(final.dialog,'Replacement dialog');
        assert.equal(final.page,'Conversations');
        assert.deepEqual(final.calls,['/dashboard/unlock-check',challenge,unlock]);
        assert.equal(final.sessionPresent,false);
      }
      results.push({test,signedProofVerified:true,approvedRepairRequests:final.calls.filter(path=>path===configure).length,
        sessionPresent:final.sessionPresent,dialog:final.dialog});
    } finally { await context.close(); }
  }
  assert.deepEqual(errors,[]);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
const hashes = Object.fromEntries([...accessed].sort().map(path=>[path,createHash('sha256').update(source.get(path)).digest('hex')]));
assert.deepEqual(Object.keys(hashes).filter(path => path !== 'fixture.mjs'), Object.keys(expected.fixturePaths).sort());
const result = {accounts,identity,base,fixturePaths:hashes,results,errors};
if (output) writeFileSync(output, JSON.stringify(result,null,2)+'\n', { flag: 'wx' });
console.log(JSON.stringify(result,null,2));
