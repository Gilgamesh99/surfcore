import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMagpieImageGenerator, magpiePendingId } from '../src/magpie-image-backend.js';
import { registerGeneratedImageTools } from '../src/generated-image-mcp.js';
import { RESTRICTED_TOOL_NAMES, apply } from '../plugins/surfcore/qq-tool-restrict.mjs';
import { z } from 'zod';

const catalog = { tools: [{ name: 'generate_image', inputSchema: { properties: { path: { type: 'string' } } } }, { name: 'generation_result' }] };
async function fixture(run, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-backend-'));
  const calls = [], lifecycle = [];
  const client = { connect: async () => lifecycle.push('connect'), close: async () => lifecycle.push('close'), listTools: async () => catalog,
    callTool: async input => { calls.push(input); return overrides.respond?.(input, root); }, ...overrides.client };
  const generate = createMagpieImageGenerator({ getConfig: () => ({ magpieCommand: process.execPath }), clientFactory: () => client, transportFactory: () => ({}) });
  try { await run({ generate, root, calls, lifecycle }); }
  finally { await fs.rm(root, { force: true, recursive: true }); }
}

test('backend: one client polls one pending job; fixed single-image parameters', async () => fixture(async ({ generate, root, calls, lifecycle }) => {
  await generate({ prompt: 'whale', size: '1024x1024', path: path.join(root, 'image.png') });
  assert.deepEqual(calls.map(c => c.name), ['generate_image', 'generation_result']);
  assert.equal(calls[0].arguments.n, 1);
  assert.equal(calls[0].arguments.path, path.join(root, 'image.png'));
  assert.equal(calls[0].arguments.reference_images, undefined);
  assert.equal(calls[1].arguments.id, 'image-10-2');
  assert.deepEqual(lifecycle, ['connect', 'close']);
}, { respond: async (input, root) => {
  if (input.name === 'generate_image') return { content: [{ type: 'text', text: 'Still going: call generation_result with id "image-10-2" to wait.' }] };
  await fs.writeFile(path.join(root, 'image.png'), 'fixture image, validated by separate service tests');
  return { content: [{ type: 'text', text: 'Generated with fixture, saved to:\n- untrusted path' }] };
} }));

test('backend: normalizes an exact host-owned JPEG filename without following result paths', async () => fixture(async ({ generate, root }) => {
  const output = path.join(root, 'image.png');
  await generate({ prompt: 'whale', size: '1024x1024', path: output });
  assert.equal(await fs.readFile(output, 'utf8'), 'jpeg fixture');
}, { respond: async (_input, root) => { await fs.writeFile(path.join(root, 'image.jpeg'), 'jpeg fixture'); return { content: [] }; } }));

test('backend: missing/unknown output and provider error are visible and sanitized', async () => {
  for (const [response, code] of [[{ content: [{ type: 'text', text: 'Generated, saved to:\n- C:/secret.png' }] }, 'IMAGE_OUTPUT_MISSING'],
    [{ isError: true, content: [{ type: 'text', text: 'private-key-secret' }] }, 'IMAGE_BACKEND_FAILED']]) {
    await fixture(async ({ generate, root }) => {
      await assert.rejects(generate({ prompt: 'whale', size: '1024x1024', path: path.join(root, 'image.png') }), error => {
        assert.equal(error.code, code); assert.ok(error.hint); assert.ok(!error.message.includes('private-key-secret')); return true;
      });
    }, { respond: async () => response });
  }
});

test('backend: incompatible schema and revoked policy stop before paid request', async () => {
  await fixture(async ({ generate, root, calls }) => {
    await assert.rejects(generate({ prompt: 'whale', path: path.join(root, 'image.png') }), error => error.code === 'IMAGE_BACKEND_INCOMPATIBLE' && !!error.hint);
    assert.equal(calls.length, 0);
  }, { client: { listTools: async () => ({ tools: [] }) } });
  await fixture(async ({ generate, root, calls }) => {
    await assert.rejects(generate({ prompt: 'whale', path: path.join(root, 'image.png') }, { assertAllowed: () => { throw Object.assign(new Error('revoked'), { code: 'IMAGE_NOT_ALLOWED' }); } }), { code: 'IMAGE_NOT_ALLOWED' });
    assert.equal(calls.length, 0);
  });
});

test('MCP: narrow schemas, explicit query timeout and structured errors', async () => {
  const tools = new Map(), requests = [];
  registerGeneratedImageTools({ server: { tool: (name, description, schema, handler) => tools.set(name, { description, schema, handler }) }, z,
    agentApi: async (route, init) => { requests.push({ route, ...init }); throw Object.assign(new Error('disabled'), { code: 'IMAGE_DISABLED', hint: 'enable in settings' }); } });
  assert.deepEqual([...tools.keys()], ['qq_generate_image', 'qq_image_result', 'qq_send_image']);
  assert.deepEqual(Object.keys(tools.get('qq_generate_image').schema).sort(), ['key', 'token', 'prompt', 'size'].sort());
  const response = await tools.get('qq_image_result').handler({ key: 'group:456', token: 'fixture', imageId: 'fixture-id' });
  assert.equal(response.isError, true);
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.code, 'IMAGE_DISABLED'); assert.ok(data.hint);
  assert.equal(requests[0].timeoutMs, 30000);
  assert.equal(JSON.parse(requests[0].body).token, undefined);
  assert.equal(requests[0].headers['x-agent-token'], 'fixture');
});

test('QQ guard: raw Magpie hidden/blocked including late registration, wrappers allowed', () => {
  const raw = ['generate_image', 'generate_video', 'generation_result'].map(n => `mcp__magpie-image__${n}`);
  for (const name of raw) assert.ok(RESTRICTED_TOOL_NAMES.includes(name));
  let guard; const hidden = new Set(); const events = new Map();
  const ctx = { tools: { restrict: ({ deny }) => deny.forEach(name => hidden.add(name)), guard: fn => { guard = fn; } },
    on: (name, fn) => events.set(name, fn), logger: () => ({ info() {}, warn() {}, debug() {} }) };
  apply(ctx);
  for (const name of raw) { assert.ok(hidden.has(name)); assert.ok(guard({ name })); }
  for (const name of ['qq_generate_image', 'qq_image_result', 'qq_send_image']) assert.equal(guard({ name: `mcp__snowluma__${name}` }), undefined);
  // Late registration: unavailable tools initially reject restrict; the event
  // retries those failures while successful restrictions remain installed.
  let available = false;
  const lateHidden = new Set(), lateEvents = new Map();
  apply({ tools: { restrict: ({ deny }) => { for (const name of deny) {
    if (raw.includes(name) && !available) throw new Error('fixture tool not registered yet');
    lateHidden.add(name);
  } }, guard() {} }, on: (name, fn) => lateEvents.set(name, fn) });
  for (const name of raw) assert.ok(!lateHidden.has(name));
  available = true; lateEvents.get('tools/change')();
  for (const name of raw) assert.ok(lateHidden.has(name));
  assert.equal(magpiePendingId({ content: [{ type: 'text', text: 'The model said "image-10-2"' }] }), null);
});
