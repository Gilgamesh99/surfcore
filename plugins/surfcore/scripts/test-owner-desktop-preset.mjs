import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installOwnerDesktopPreset } from '../lib/owner-desktop-preset.js';

let passed = 0;
async function test(name, run) { await run(); console.log('PASS', name); passed++; }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-desktop-preset-'));
const source = pathToFileURL(dir + path.sep);
const rows = '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n- id: native\n  name: "@deepseek-ai/dsh-tool-executor-native"\n- id: boundary\n  name: ./owner-desktop-boundary.mjs\n';
const reset = () => {
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: Owner desktop fixture\ndescription: fixture\norder: 900\n');
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), rows);
};
try {
  reset();
  await test('shipped declaration uses the native executor and the same boundary module', async () => {
    let definition;
    const p=installOwnerDesktopPreset({agentPresets:{register:async d=>{definition=d;return async()=>{};},resolve:async id=>({id})}});
    await p.ready; assert.equal(p.status().ok,true);
    assert.equal(definition.plugins.find(row=>row.id==='owner-desktop-boundary').name,new URL('../../../dsh/agent-presets/owner-desktop/owner-desktop-boundary.mjs',import.meta.url).href);
    await p.stop();
  });
  await test('official registration pins the boundary to its source and removes on stop', async () => {
    let definition, removed = 0;
    const p = installOwnerDesktopPreset({ agentPresets: {
      register: async d => { definition = d; return async () => { removed++; }; },
      resolve: async id => ({ id }),
    } }, { source });
    assert.equal(p.status().ok, false); await p.ready;
    assert.equal(p.status().ok, true); assert.equal(definition.id, 'owner-desktop');
    assert.equal(definition.plugins.length, 3);
    assert.equal(definition.plugins[2].name, new URL('owner-desktop-boundary.mjs', source).href);
    await p.stop(); await p.stop(); assert.equal(removed, 1); assert.equal(p.status().ok, false);
  });
  await test('missing host service and broken activation remain unavailable', async () => {
    const absent = installOwnerDesktopPreset({}, { source }); await absent.ready;
    assert.equal(absent.status().ok, false);
    const broken = installOwnerDesktopPreset({ agentPresets: { register: async () => async () => {}, resolve: async id => ({id, broken:'missing native executor'}) } }, {source});
    await broken.ready; assert.equal(broken.status().ok, false); await broken.stop();
  });
  await test('unexpected or duplicate plugin composition is rejected before registration', async () => {
    let calls=0;
    for (const text of [rows.replace('@deepseek-ai/dsh-persona','@deepseek-ai/dsh-tools-local'), rows.replace('./owner-desktop-boundary.mjs','@deepseek-ai/dsh-persona')]) {
      fs.writeFileSync(path.join(dir,'agent.cordis.yml'), text);
      const p = installOwnerDesktopPreset({agentPresets:{register:async()=>{calls++;return()=>{};},resolve:async id=>({id})}},{source});
      await p.ready; assert.equal(p.status().ok,false);
    }
    assert.equal(calls,0); reset();
  });
  await test('existing preset conflict never replaces the existing registration', async () => {
    let resolved=false;
    const p=installOwnerDesktopPreset({agentPresets:{register:async()=>{throw new Error('Duplicate agent preset: owner-desktop');},resolve:async()=>{resolved=true;}}},{source});
    await p.ready; assert.equal(p.status().ok,false); assert.equal(resolved,false); await p.stop();
  });
  await test('unload while registration is pending disposes its later result', async () => {
    let release, removed=0;
    const pending=new Promise(resolve=>{release=resolve;});
    const p=installOwnerDesktopPreset({agentPresets:{register:()=>pending,resolve:async id=>({id})}},{source});
    const stopped=p.stop(); release(async()=>{removed++;}); await stopped;
    assert.equal(p.status().ok,false); assert.equal(removed,1);
  });
  await test('unload while diagnostic is pending cannot publish readiness', async () => {
    let release, removed=0;
    const pending=new Promise(resolve=>{release=resolve;});
    const p=installOwnerDesktopPreset({agentPresets:{register:async()=>async()=>{removed++;},resolve:()=>pending}},{source});
    await Promise.resolve(); const stopped=p.stop(); release({id:'owner-desktop'}); await stopped;
    assert.equal(p.status().ok,false); assert.equal(removed,1);
  });
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
console.log('Owner desktop preset: '+passed+' cases passed (isolated fixtures).');
