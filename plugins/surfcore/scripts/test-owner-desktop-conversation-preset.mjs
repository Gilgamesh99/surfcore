import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installOwnerDesktopConversationPreset } from '../lib/owner-desktop-conversation-preset.js';

let passed = 0;
async function test(name, run) { await run(); console.log('PASS', name); passed++; }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-desktop-preset-'));
const source = pathToFileURL(dir + path.sep);
const rows = '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n- id: native\n  name: "@deepseek-ai/dsh-tool-executor-native"\n- id: boundary\n  name: ./boundary.mjs\n';
const reset = () => {
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: Owner desktop fixture\ndescription: fixture\norder: 900\n');
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), rows);
};
try {
  reset();
  await test('shipped declaration uses the native executor and the same boundary module', async () => {
    let definition;
    const p=installOwnerDesktopConversationPreset({agentPresets:{register:async d=>{definition=d;return async()=>{};},resolve:async id=>({id})}});
    await p.ready; assert.equal(p.status().ok,true);
    assert.equal(definition.plugins.find(row=>row.name.endsWith('/boundary.mjs')).name,new URL('../../../dsh/agent-presets/owner-desktop-conversation/boundary.mjs',import.meta.url).href);
    await p.stop();
  });
  await test('cached preset boundary shares authorization with freshly loaded plugin modules', async () => {
    const boundary = await import(new URL('../../../dsh/agent-presets/owner-desktop-conversation/boundary.mjs', import.meta.url));
    const gateUrl = new URL('../lib/owner-desktop-conversation-gate.js', import.meta.url).href;
    const initial = await import(gateUrl);
    const handlers = new Map(); let allowed = [], guard;
    const executor = { describe: definitions => ({ schemas: definitions }) };
    const scopedTools = { restrict: options => { allowed = options.allow; return () => {}; } };
    const agent = { ctx: { get: name => name === 'tools' ? scopedTools : undefined } };
    const ctx = { on: (name, callback) => handlers.set(name, callback), tools: {
      guard: callback => { guard = callback; },
      view: () => ({ restrictableNames: new Set(['windows_desktop', 'mcp__windows__Click', 'run_code']) }),
      definitions: () => allowed.map(name => ({ name })), selectExecutor: () => executor,
    } };
    boundary.apply(ctx); handlers.get('agent/created')({ agent });
    for (const generation of [1, 2]) {
      // A fresh plugin module namespace with the external preset still cached
      // reproduces the host's package-removal eviction boundary without a host.
      const reloaded = await import(gateUrl + '?pluginReload=' + generation);
      assert.notEqual(reloaded, initial);
      assert.match(guard({ agent, name: 'windows_desktop' }), /owner-task-required/);
      const grant = reloaded.armOwnerDesktopConversation(agent, () => undefined);
      assert.ok(grant, 'reloaded plugin must arm the previously cached preset boundary');
      assert.equal(grant.activate(), true);
      assert.equal(guard({ agent, name: 'windows_desktop' }), undefined);
      assert.match(guard({ agent, name: 'run_code' }), /tool-not-allowed/);
      grant.close();
      assert.match(guard({ agent, name: 'windows_desktop' }), /owner-task-required/);
    }
    handlers.get('dispose')();
    assert.match(guard({ agent, name: 'windows_desktop' }), /owner-task-required/);
  });
  await test('official registration pins the boundary to its source and removes on stop', async () => {
    let definition, removed = 0;
    const p = installOwnerDesktopConversationPreset({ agentPresets: {
      register: async d => { definition = d; return async () => { removed++; }; },
      resolve: async id => ({ id }),
    } }, { source });
    assert.equal(p.status().ok, false); await p.ready;
    assert.equal(p.status().ok, true); assert.equal(definition.id, 'owner-desktop-conversation');
    assert.equal(definition.plugins.length, 3);
    assert.equal(definition.plugins[2].name, new URL('boundary.mjs', source).href);
    await p.stop(); await p.stop(); assert.equal(removed, 1); assert.equal(p.status().ok, false);
  });
  await test('missing host service and broken activation remain unavailable', async () => {
    const absent = installOwnerDesktopConversationPreset({}, { source }); await absent.ready;
    assert.equal(absent.status().ok, false);
    const broken = installOwnerDesktopConversationPreset({ agentPresets: { register: async () => async () => {}, resolve: async id => ({id, broken:'missing native executor'}) } }, {source});
    await broken.ready; assert.equal(broken.status().ok, false); await broken.stop();
  });
  await test('unexpected or duplicate plugin composition is rejected before registration', async () => {
    let calls=0;
    for (const text of [rows.replace('@deepseek-ai/dsh-persona','@deepseek-ai/dsh-tools-local'), rows.replace('./boundary.mjs','@deepseek-ai/dsh-persona')]) {
      fs.writeFileSync(path.join(dir,'agent.cordis.yml'), text);
      const p = installOwnerDesktopConversationPreset({agentPresets:{register:async()=>{calls++;return()=>{};},resolve:async id=>({id})}},{source});
      await p.ready; assert.equal(p.status().ok,false);
    }
    assert.equal(calls,0); reset();
  });
  await test('existing preset conflict never replaces the existing registration', async () => {
    let resolved=false;
    const p=installOwnerDesktopConversationPreset({agentPresets:{register:async()=>{throw new Error('Duplicate agent preset: owner-desktop');},resolve:async()=>{resolved=true;}}},{source});
    await p.ready; assert.equal(p.status().ok,false); assert.equal(resolved,false); await p.stop();
  });
  await test('unload while registration is pending disposes its later result', async () => {
    let release, removed=0;
    const pending=new Promise(resolve=>{release=resolve;});
    const p=installOwnerDesktopConversationPreset({agentPresets:{register:()=>pending,resolve:async id=>({id})}},{source});
    const stopped=p.stop(); release(async()=>{removed++;}); await stopped;
    assert.equal(p.status().ok,false); assert.equal(removed,1);
  });
  await test('unload while diagnostic is pending cannot publish readiness', async () => {
    let release, removed=0;
    const pending=new Promise(resolve=>{release=resolve;});
    const p=installOwnerDesktopConversationPreset({agentPresets:{register:async()=>async()=>{removed++;},resolve:()=>pending}},{source});
    await Promise.resolve(); const stopped=p.stop(); release({id:'owner-desktop-conversation'}); await stopped;
    assert.equal(p.status().ok,false); assert.equal(removed,1);
  });
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
console.log('Owner desktop preset: '+passed+' cases passed (isolated fixtures).');
