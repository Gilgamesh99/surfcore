import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOwnerDesktopSettings } from '../lib/owner-desktop-settings.js';
function fixture(overrides={}, factory=createOwnerDesktopSettings) {
  let settings={enabled:false,parentSessionId:'human',authorizationEpoch:'old',timeoutMs:600000};const events=[];
  const options={runtime:{status:()=>({ok:true,phase:'idle'}),stop:async()=>{events.push('stop')},start:()=>events.push('start')},policy:{parentSessions:()=>[{id:'human',title:'管理会话'}]},getSettings:()=>settings,getOwnerQQ:()=> '42',bridge:async (route,args)=>{events.push({route,args});return {ok:true,data:{ok:true}}},saveSettings:async(next,expected)=>{events.push('save');assert.equal(expected,settings.authorizationEpoch);settings=next},...overrides};
  return {controller:factory(options),events,getSettings:()=>settings};
}
test('save cancels old task before persisting new epoch and restarting intake', async()=>{
 const f=fixture();const r=await f.controller.configure({enabled:true,expectedEpoch:'old'});assert.equal(r.ok,true);assert.notEqual(r.settings.authorizationEpoch,'old');
 assert.deepEqual(f.events.map(x=>typeof x==='string'?x:x.route),['stop','/api/owner-desktop/cancel','save','start']);assert.deepEqual(f.events[1].args.body,{});
});
test('off then on generates different epochs so an old lease cannot revive',async()=>{
 const f=fixture();const a=await f.controller.configure({enabled:true,expectedEpoch:'old'});const b=await f.controller.configure({enabled:false,expectedEpoch:a.settings.authorizationEpoch});const c=await f.controller.configure({enabled:true,expectedEpoch:b.settings.authorizationEpoch});
 assert.equal(new Set([a.settings.authorizationEpoch,b.settings.authorizationEpoch,c.settings.authorizationEpoch]).size,3);
});
test('stale UI and unknown fields fail without cancelling or saving',async()=>{
 const f=fixture();for(const body of [{enabled:true,expectedEpoch:'stale'},{enabled:true,expectedEpoch:'old',grantWindows:true}]){const r=await f.controller.configure(body);assert.equal(r.ok,false);assert.ok(r.code&&r.hint);}assert.equal(f.events.length,0);
});
test('nonmanagement parent and absent owner cannot enable desktop use',async()=>{
 for(const overrides of [{policy:{parentSessions:()=>[]}},{getOwnerQQ:()=>''}]){const f=fixture(overrides);const r=await f.controller.configure({enabled:true,expectedEpoch:'old'});assert.equal(r.ok,false);assert.ok(r.hint);assert.equal(f.events.length,0);}
});
test('bridge cancellation failure blocks enable and keeps the runtime stopped',async()=>{
 const f=fixture({bridge:async()=>({ok:false,data:{ok:false}})});const r=await f.controller.configure({enabled:true,expectedEpoch:'old'});assert.equal(r.code,'owner-desktop.cancel-unconfirmed');assert.deepEqual(f.events,['stop']);assert.equal(f.getSettings().enabled,false);
});
test('disabling still revokes epoch when bridge is offline',async()=>{
 const f=fixture({bridge:async()=>({ok:false})});const r=await f.controller.configure({enabled:false,expectedEpoch:'old'});assert.equal(r.ok,true);assert.notEqual(r.settings.authorizationEpoch,'old');assert.equal(r.settings.enabled,false);
});
test('status exposes actionable backend failures without private command text',async()=>{
 const f=fixture({bridge:async()=>({ok:false})});const r=await f.controller.status();assert.equal(r.ok,true);assert.equal(r.ownerConfigured,true);assert.equal(r.broker.ok,false);assert.ok(r.broker.code&&r.broker.hint);assert.equal(r.settings.parentSessionId,'human');
});

test('long and unlimited duration changes revoke old task and persist an exact new value', async()=>{
 const f=fixture();let epoch='old';
 for(const timeoutMs of [1800000,86400000,0,600000]) {
  f.events.length=0;const result=await f.controller.configure({enabled:true,timeoutMs,expectedEpoch:epoch});
  assert.equal(result.ok,true);assert.equal(result.settings.timeoutMs,timeoutMs);assert.notEqual(result.settings.authorizationEpoch,epoch);epoch=result.settings.authorizationEpoch;
  assert.deepEqual(f.events.map(x=>typeof x==='string'?x:x.route),['stop','/api/owner-desktop/cancel','save','start']);
 }
});
test('invalid duration never cancels or changes existing authorization',async()=>{
 const f=fixture();for(const timeoutMs of [null,false,'',-1,29999,86400001,Infinity]) {
  const r=await f.controller.configure({enabled:true,timeoutMs,expectedEpoch:'old'});
  assert.equal(r.ok,false);assert.equal(r.code,'owner-desktop.timeout-invalid');assert.ok(r.hint);
 }
 assert.equal(f.events.length,0);assert.equal(f.getSettings().authorizationEpoch,'old');
});

test('reloaded settings and runtime work while the host retains the old config module',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-duration-cache-'));
 try {
  fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'module'}));
  const cachedPath=path.join(root,'src/owner-desktop-config.js');
  fs.writeFileSync(cachedPath,"export function normalizeOwnerDesktopSettings(){throw new Error('stale configuration used');} export function desktopConfigError(code,message,hint){return Object.assign(new Error(message),{code,hint});}\n");
  const cachedUrl=pathToFileURL(cachedPath).href;const cached=await import(cachedUrl);
  const files=['src/owner-desktop-config.js','src/owner-desktop-options.js','plugins/surfcore/lib/owner-desktop-settings.js','plugins/surfcore/lib/owner-desktop-runtime.js','dsh/agent-presets/owner-desktop/owner-desktop-boundary.mjs'];
  for(const file of files){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(new URL('../../../'+file,import.meta.url),target);}
  assert.equal(await import(cachedUrl),cached,'Node retains the old ESM instance despite updated disk contents');
  const loaded=await import(pathToFileURL(path.join(root,'plugins/surfcore/lib/owner-desktop-settings.js')).href);
  const runtime=await import(pathToFileURL(path.join(root,'plugins/surfcore/lib/owner-desktop-runtime.js')).href);
  assert.equal(typeof runtime.installOwnerDesktopRuntime,'function');
  const f=fixture({},loaded.createOwnerDesktopSettings);const result=await f.controller.configure({enabled:true,timeoutMs:0,expectedEpoch:'old'});
  assert.equal(result.ok,true);assert.equal(result.settings.timeoutMs,0);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
