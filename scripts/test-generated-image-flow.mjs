import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createGeneratedImageRoutes } from '../src/generated-image-routes.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(run, { generate, globals, socialV2 } = {}) {
  let generations = 0;
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, images: { enabled: true, cooldownMs: 0 }, ...socialV2 }, fishGuard: { enabled: false } },
    globals: { createMagpieImageGenerator: () => async (input, context) => {
      generations++;
      if (generate) return generate(input, context);
      await fs.writeFile(input.path, png);
    }, ...globals } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, token = h.getSocialV2State(body.key).agentToken) => {
    const response = await fetch(`${base}/api/socialV2/${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', ...(token === null ? {} : { 'x-agent-token': token }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    return { status: response.status, ...await response.json() };
  };
  try { await run({ h, post, count: () => generations }); }
  finally { await new Promise(r => server.close(r)); await h.close(); }
}
const readyImage = async post => {
  const job = await post('generate-image', { key: 'group:456', prompt: 'A tiny blue whale' });
  assert.equal(job.ok, true, JSON.stringify(job));
  assert.match(job.imageId, /^[a-f0-9]{48}$/);
  const ready = await post('image-result', { key: 'group:456', imageId: job.imageId });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  return job.imageId;
};
const denied = (result, code) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, code, JSON.stringify(result));
  assert.ok(result.hint);
};

test('bridge: generate → result → OneBot image, duplicate requests send once', async () => fixture(async ({ h, post, count }) => {
  const imageId = await readyImage(post);
  const again = await post('generate-image', { key: 'group:456', prompt: 'A tiny blue whale' });
  assert.equal(again.imageId, imageId);
  assert.equal(count(), 1);
  assert.equal(again.path, undefined);
  const results = await Promise.all(Array.from({ length: 3 }, () => post('send-image', { key: 'group:456', imageId })));
  for (const result of results) assert.equal(result.sent, 1, JSON.stringify(result));
  const sent = h.calls.http.filter(c => c.url.endsWith('/send_group_msg'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.group_id, 456);
  assert.equal(sent[0].body.message[0].type, 'image');
  assert.equal(sent[0].body.message[0].data.file, `base64://${png.toString('base64')}`);
  assert.equal((await post('send-image', { key: 'group:456', imageId })).alreadySent, true);
  assert.equal(h.getSocialV2State('group:456').recentMessages.at(-1).generatedImage.imageId, imageId);
}));

test('bridge: requires current session token, whitelist and bounded schema', async () => fixture(async ({ h, post, count }) => {
  const input = { key: 'group:456', prompt: 'A tiny blue whale' };
  denied(await post('generate-image', input, null), 'IMAGE_ACCESS_DENIED');
  denied(await post('generate-image', input, 'stale-token'), 'IMAGE_ACCESS_DENIED');
  denied(await post('generate-image', { ...input, key: 'group:789' }), 'IMAGE_ACCESS_DENIED');
  denied(await post('generate-image', { ...input, path: 'secret.txt' }), 'IMAGE_INVALID_REQUEST');
  denied(await post('generate-image', { ...input, reference_images: ['https://example.com/x'] }), 'IMAGE_INVALID_REQUEST');
  denied(await post('generate-image', { ...input, prompt: h.getSocialV2State('group:456').agentToken }), 'IMAGE_SENSITIVE_PROMPT');
  assert.equal(count(), 0);
  const imageId = await readyImage(post);
  denied(await post('image-result', { key: 'private:123', imageId }), 'IMAGE_NOT_FOUND');
  denied(await post('send-image', { key: 'private:123', imageId }), 'IMAGE_NOT_FOUND');
  assert.equal(h.calls.http.filter(c => c.url.endsWith('/send_private_msg')).length, 0);
}));

test('bridge: disabled master/tool and changed mode refuse generation/sending', async () => fixture(async ({ h, post }) => {
  const imageId = await readyImage(post);
  const input = { key: 'group:456', imageId };
  h.cfg.socialV2.images.enabled = false;
  denied(await post('send-image', input), 'IMAGE_DISABLED');
  h.cfg.socialV2.images.enabled = true;
  h.cfg.socialV2.tools.sendImage = false;
  denied(await post('send-image', input), 'IMAGE_DISABLED');
  h.cfg.socialV2.tools.sendImage = true;
  h.setMode('chat');
  denied(await post('send-image', input), 'IMAGE_ACCESS_DENIED');
  assert.equal(h.calls.http.filter(c => c.url.endsWith('/send_group_msg')).length, 0);
}));

test('bridge: queued send rechecks current policy', async () => fixture(async ({ h, post }) => {
  const imageId = await readyImage(post);
  h.cfg.socialV2.send.maxSendPerMinute = 1;
  h.getSocialV2State('group:456').sendTimes.push(Date.now());
  const before = Number(h.getSocialV2State('group:456').tokenTurnSent) || 0;
  denied(await post('send-image', { key: 'group:456', imageId }), 'IMAGE_SEND_LIMIT');
  assert.equal(Number(h.getSocialV2State('group:456').tokenTurnSent) || 0, before);
  assert.equal(h.calls.http.filter(c => c.url.endsWith('/send_group_msg')).length, 0);
  h.getSocialV2State('group:456').sendTimes = [];
  assert.equal((await post('send-image', { key: 'group:456', imageId })).sent, 1);
}));

test('bridge: unconfirmed delivery never retries and retains attempt budget', async () => {
  let sends = 0;
  await fixture(async ({ h, post }) => {
    const imageId = await readyImage(post), input = { key: 'group:456', imageId };
    denied(await post('send-image', input), 'IMAGE_DELIVERY_UNKNOWN');
    denied(await post('send-image', input), 'IMAGE_DELIVERY_UNKNOWN');
    assert.equal(sends, 1);
    assert.equal(h.getSocialV2State('group:456').sendTimes.length, 1);
    assert.equal((await post('image-result', input)).delivery.status, 'unknown');
  }, { globals: { fetch: async url => {
    if (String(url).endsWith('/send_group_msg')) { sends++; throw new Error('network response lost'); }
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
  } } });
});

test('bridge: a replacement token cannot join an old owner send promise', async () => {
  const entered = deferred(), release = deferred();
  let sends = 0;
  await fixture(async ({ h, post }) => {
    const imageId = await readyImage(post), input = { key: 'group:456', imageId };
    const original = post('send-image', input);
    await entered.promise;
    h.getSocialV2State(input.key).agentToken = 'replacement-fixture-token';
    try {
      denied(await post('send-image', input), 'IMAGE_NOT_FOUND');
    } finally { release.resolve(); }
    denied(await original, 'IMAGE_ACCESS_DENIED');
    assert.equal(sends, 1);
  }, { globals: { fetch: async url => {
    if (String(url).endsWith('/send_group_msg')) { sends++; entered.resolve(); await release.promise; }
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  } } });
});

test('bridge: pre-transport budget rollback restores only the reserved turn', async () => {
  let reserve;
  await fixture(async ({ h }) => {
    const st = h.getSocialV2State('group:456');
    st.tokenTurnSent = 0;
    let rollback = reserve('group:456');
    assert.equal(st.tokenTurnSent, 1);
    rollback(); rollback();
    assert.equal(st.tokenTurnSent, 0);
    assert.equal(st.sendTimes.length, 0);
    rollback = reserve('group:456');
    st.wakeConfig.wakeCount++;
    st.tokenTurnSent = 2;
    rollback();
    assert.equal(st.tokenTurnSent, 2);
    assert.equal(st.sendTimes.length, 0);
  }, { socialV2: { tokenGuard: { enabled: true } }, globals: {
    createGeneratedImageRoutes(options) { reserve = options.reserveSend; return createGeneratedImageRoutes(options); },
  } });
});

test('bridge: image ledger remains installation-wide with character-scoped other state', async () => {
  let imageRoot;
  await fixture(async ({ h }) => {
    assert.equal(imageRoot, path.join(h.temp, 'state', 'generated-images'));
  }, { globals: {
    activePlatformStateDir: legacy => path.join(legacy, 'another-character'),
    createGeneratedImageRoutes(options) { imageRoot = options.root; return createGeneratedImageRoutes(options); },
  } });
});

test('bridge: permission revocation during generation cannot publish ready output', async () => {
  const entered = deferred(), release = deferred();
  await fixture(async ({ h, post }) => {
    const job = await post('generate-image', { key: 'group:456', prompt: 'blue whale' });
    await entered.promise;
    h.cfg.socialV2.tools.generateImage = false;
    release.resolve();
    const result = await post('image-result', { key: 'group:456', imageId: job.imageId });
    denied(result, 'IMAGE_NOT_ALLOWED');
  }, { generate: async ({ path }) => { entered.resolve(); await release.promise; await fs.writeFile(path, png); } });
});
