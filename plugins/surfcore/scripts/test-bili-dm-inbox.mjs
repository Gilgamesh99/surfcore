// Offline behavioral tests; all state and subprocess output stays in a fresh temp directory.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDmInbox, exactDmId, dmTextPrefix, normalizeDmMessage } from '../tools/lib/dm-inbox.mjs'

const OWNER = '900002', SELF = '900001', OTHER = '900003'
const BV = 'BV1xx411c7mD', BV2 = 'BV1Q541167Qg', TS = 1800000000
const reply = data => new Response(JSON.stringify({ code: 0, data }), { status: 200 })
const seqOrder = (a, b) => BigInt(a.msg_seq) < BigInt(b.msg_seq) ? -1 : BigInt(a.msg_seq) > BigInt(b.msg_seq) ? 1 : 0
const message = (seq, content = 'text', options = {}) => ({ msg_seq: String(seq), sender_uid: OWNER, receiver_id: SELF,
  timestamp: TS + Number(BigInt(seq) % 100n), msg_type: 1, content: typeof content === 'object' ? JSON.stringify(content) : JSON.stringify({ content }), ...options })
const old = () => message('100', 'old', { timestamp: TS - 100 })
const card = (seq = '101', fields = { source: 5, id: 12345, title: '命运2' }) => message(seq, fields, { msg_type: 7 })
const baseState = (seq = '100') => ({ version: 2, revision: 1, ownerMid: OWNER, selfMid: SELF,
  cursors: { [OWNER]: { seq, ts: TS - 100 } }, recent: {}, started: { owner: TS - 100 }, acked: [], pending: null })
const saveJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)) }
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

function network(fixture, calls) {
  return async (input, options) => {
    const url = new URL(input)
    calls.push({ url: url.href, options })
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.body, undefined)
    const allowed = new Map([
      ['api.vc.bilibili.com', ['/session_svr/v1/session_svr/get_sessions', '/svr_sync/v1/svr_sync/fetch_session_msgs']],
      ['api.bilibili.com', ['/x/web-interface/view']]
    ])
    assert.equal(url.protocol, 'https:'); assert.ok(allowed.get(url.hostname)?.includes(url.pathname), 'fixed read-only endpoint')
    if (fixture.override) { const override = await fixture.override(url, options); if (override !== undefined) return override }
    if (url.pathname.endsWith('/get_sessions')) {
      const session_list = Object.entries(fixture.conversations).map(([mid, list]) => {
        const last = [...list].sort(seqOrder).at(-1)
        return { talker_id: mid, session_type: 1, last_msg: last, max_seqno: last?.msg_seq || '0', session_ts: '1800000000000000', account_info: { name: 'fixture peer' } }
      })
      return reply({ session_list, has_more: 0 })
    }
    if (url.pathname.endsWith('/fetch_session_msgs')) {
      const rows = [...(fixture.conversations[url.searchParams.get('talker_id')] || [])].sort(seqOrder).reverse()
      const before = url.searchParams.get('begin_seqno'), size = Number(url.searchParams.get('size'))
      const available = before ? rows.filter(m => BigInt(m.msg_seq) < BigInt(before)) : rows
      return reply({ messages: available.slice(0, size), has_more: available.length > size ? 1 : 0 })
    }
    return reply({ aid: url.searchParams.get('aid') || '12345', bvid: url.searchParams.get('bvid') || BV, title: '公开视频标题' })
  }
}

if (process.argv[2] === '--fixture-cli') {
  const fixture = readJson(process.argv[3])
  globalThis.fetch = network(fixture, [])
  process.argv = [process.execPath, fileURLToPath(new URL('../tools/commands/dm-await.mjs', import.meta.url)), ...process.argv.slice(4)]
  await import('../tools/commands/dm-await.mjs')
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-dm-inbox-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('offline test forbids real fetch') }
  let passed = 0, failed = 0, counter = 0
  function fixture(options = {}) {
    const stateFile = path.join(root, String(++counter), 'dm-await-state.json')
    const data = { conversations: { [OWNER]: [old(), message('101')] } }, calls = []
    if (options.state !== null) saveJson(stateFile, options.state || baseState())
    const settings = { stateFile, ownerMid: OWNER, selfMid: SELF, ownerName: 'fixture owner', now: () => (TS + 100) * 1000, fetchImpl: network(data, calls), ...options }
    delete settings.state
    return { data, calls, stateFile, inbox: createDmInbox(settings), settings }
  }
  const checkFailure = (result, code) => {
    assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.hit, false); assert.deepEqual(result.items, [])
    if (code) assert.equal(result.code, code, JSON.stringify(result))
    assert.ok(result.code && result.error && result.hint); assert.ok(!JSON.stringify(result).includes('DO_NOT_LEAK'))
  }
  async function test(name, fn) {
    try { await fn(); passed++; console.log('PASS ' + name) }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack) }
  }
  try {
    await test('exact identifiers, Unicode truncation, and all incoming message types', async () => {
      assert.equal(exactDmId('1261813571425140745'), '1261813571425140745')
      for (const bad of [1261813571425140745, 1.2, -1, null, '001', '1e3', ' 2', {}, Infinity]) assert.equal(exactDmId(bad), '')
      assert.equal(exactDmId(123), '123'); assert.equal(exactDmId(0, true), '0')
      assert.equal(dmTextPrefix('a😀b', 2), 'a')
      const normal = await normalizeDmMessage(message('101', { text: 'hello 😀' }, { msg_type: 99 }), { maxText: 7 })
      assert.equal(normal.type, 99); assert.equal(normal.text, 'hello '); assert.equal(normal.truncated, true)
      assert.equal(normal.error.code, 'dm.text-truncated'); assert.equal(normal.text.isWellFormed(), true)
    })
    await test('real API msg_seqno works in session and history, with safe legacy alias compatibility', async () => {
      const f = fixture()
      const real = raw => { const { msg_seq, ...rest } = raw; return { ...rest, msg_seqno: Number(msg_seq), msg_key: 9999999999999999999 } }
      const messages = [old(), card(), message('102', '把这个视频分享到群聊测试群'), message('103', 'proactive', { sender_uid: SELF, receiver_id: OWNER })].map(real)
      f.data.override = async url => {
        if (url.pathname.endsWith('/get_sessions')) return reply({ session_list: [{ talker_id: OWNER, session_type: 1, last_msg: messages.at(-1), max_seqno: 103 }], has_more: 0 })
        if (url.pathname.endsWith('/fetch_session_msgs')) return reply({ messages: messages.toReversed(), has_more: 0 })
      }
      const result = await f.inbox.poll()
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.deepEqual(result.items[0].messages.map(m => m.seq), ['101', '102'])
      assert.equal(result.items[0].messages[0].video.bvid, BV)
      assert.equal((await f.inbox.ack(result.batchId)).acked, true)
      assert.equal(readJson(f.stateFile).cursors[OWNER].seq, '103')
      assert.equal((await normalizeDmMessage({ ...message('104'), msg_seqno: 104 })).seq, '104')
      await assert.rejects(normalizeDmMessage({ ...message('104'), msg_seqno: 105 }), { code: 'dm.unsafe-id' })
      await assert.rejects(normalizeDmMessage({ ...message('104'), msg_seqno: Number.MAX_SAFE_INTEGER + 1 }), { code: 'dm.unsafe-id' })
    })
    await test('actual source5 aid card + instruction survive newer outgoing messages; stable replay and ack', async () => {
      const f = fixture()
      f.data.conversations[OWNER] = [old(), card(), message('102', '分享到QQ测试群'), message('103', 'proactive', { sender_uid: SELF, receiver_id: OWNER })]
      const result = await f.inbox.poll()
      assert.equal(result.hit, true, JSON.stringify(result)); assert.equal(result.items.length, 1)
      assert.deepEqual(result.items[0].messages.map(m => m.seq), ['101', '102'])
      assert.deepEqual(result.items[0].messages[0].video, { aid: '12345', bvid: BV, title: '公开视频标题', url: 'https://www.bilibili.com/video/' + BV })
      assert.equal(result.items[0].messages[1].text, '分享到QQ测试群')
      const saved = readJson(f.stateFile); assert.equal(saved.cursors[OWNER].seq, '100'); assert.equal(saved.pending.batchId, result.batchId)
      const count = f.calls.length
      assert.deepEqual(await f.inbox.poll(), result)
      assert.deepEqual(await createDmInbox(f.settings).poll(), result); assert.equal(f.calls.length, count)
      checkFailure(await f.inbox.ack('00000000-0000-0000-0000-000000000000'), 'dm.batch-mismatch')
      const ack = await f.inbox.ack(result.batchId); assert.equal(ack.acked, true)
      assert.equal(readJson(f.stateFile).cursors[OWNER].seq, '103')
      assert.equal((await f.inbox.ack(result.batchId)).alreadyAcked, true)
      assert.equal((await f.inbox.poll()).hit, false)
    })
    await test('video from recently acknowledged batch accompanies next-poll instruction', async () => {
      const f = fixture(); f.data.conversations[OWNER] = [old(), card()]
      const first = await f.inbox.poll(); assert.equal(first.hit, true); await f.inbox.ack(first.batchId)
      f.data.conversations[OWNER].push(message('102', '把这个视频分享过去'))
      const next = await f.inbox.poll(); assert.equal(next.hit, true)
      assert.deepEqual(next.items[0].messages.map(m => m.seq), ['102'])
      assert.equal(next.items[0].context[0].video.bvid, BV)
      assert.equal(readJson(f.stateFile).cursors[OWNER].seq, '101')
    })
    await test('same-second messages use sequence, not acknowledged timestamp', async () => {
      const f = fixture(); f.data.conversations[OWNER][1].timestamp = TS
      const a = await f.inbox.poll(); await f.inbox.ack(a.batchId)
      f.data.conversations[OWNER].push(message('102', 'same second', { timestamp: TS }))
      const b = await f.inbox.poll(); assert.equal(b.items[0].messages[0].seq, '102')
    })
    await test('missing state baselines once; subsequent new message is delivered', async () => {
      const f = fixture({ state: null }); const first = await f.inbox.poll()
      assert.equal(first.ok, true); assert.equal(first.baseline, true); assert.equal(first.hit, false)
      assert.equal(f.calls.filter(c => c.url.includes('fetch_session_msgs')).length, 0)
      f.data.conversations[OWNER].push(message('102'))
      const next = await f.inbox.poll(); assert.equal(next.hit, true); assert.equal(next.items[0].messages[0].seq, '102')
    })
    await test('legacy lastSeen and seen migrate without replay or pre-ack timestamp advance', async () => {
      for (const state of [{ lastSeen: TS, at: new Date(TS * 1000).toISOString() }, { seen: { [OWNER]: TS }, at: new Date(TS * 1000).toISOString() }]) {
        const f = fixture({ state }); f.data.conversations[OWNER] = [message('100', 'old action', { timestamp: TS }), card(), message('102')]
        const result = await f.inbox.poll(); assert.equal(result.hit, true, JSON.stringify(result))
        assert.deepEqual(result.items[0].messages.map(m => m.seq), ['101', '102'])
        assert.equal(result.warnings[0].code, 'dm.legacy-timestamp')
        const pending = readJson(f.stateFile); assert.equal(pending.lastSeen ?? pending.seen[OWNER], TS)
        assert.equal(pending.cursors[OWNER], undefined)
        await f.inbox.ack(result.batchId); assert.equal(readJson(f.stateFile).cursors[OWNER].seq, '102')
      }
    })
    await test('broadening owner scope baselines unknown peers without discarding known-owner input', async () => {
      for (const state of [baseState(), { lastSeen: TS - 100 }]) {
        const f = fixture({ state }); f.data.conversations[OTHER] = [message('999', 'old stranger action', { sender_uid: OTHER })]
        const result = await f.inbox.poll({ any: true }); assert.equal(result.hit, true, JSON.stringify(result))
        assert.deepEqual(result.items.map(item => item.mid), [OWNER]); assert.equal(readJson(f.stateFile).cursors[OTHER].seq, '999')
      }
    })
    await test('bounded descending history pages become complete chronological incoming batch', async () => {
      const f = fixture({ pageSize: 2 }); f.data.conversations[OWNER] = [old(), ...[101, 102, 103, 104, 105].map(n => message(n))]
      const r = await f.inbox.poll(); assert.equal(r.hit, true, JSON.stringify(r))
      assert.deepEqual(r.items[0].messages.map(m => m.seq), ['101', '102', '103', '104', '105'])
      const urls = f.calls.filter(call => call.url.includes('fetch_session_msgs')).map(call => new URL(call.url))
      assert.deepEqual(urls.map(u => u.searchParams.get('begin_seqno')), [null, '104', '102'])
    })
    await test('history gaps, page/message/request limits preserve state byte-for-byte', async () => {
      for (const options of [{ maxPages: 1, pageSize: 2 }, { maxMessages: 2 }, { maxRequests: 1 }, {}]) {
        const f = fixture(options); f.data.conversations[OWNER] = [101, 102, 103, 104].map(n => message(n))
        const before = fs.readFileSync(f.stateFile, 'utf8')
        const r = await f.inbox.poll(); checkFailure(r)
        assert.match(r.code, /^dm\.(history-gap|message-limit|request-limit)$/); assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before)
      }
    })
    await test('ambiguous pagination or repeating pages cannot silently advance a cursor', async () => {
      for (const hasMore of [undefined, 2, 'unexpected', 1]) {
        const f = fixture(); f.data.conversations[OWNER] = [message('101')]
        f.data.override = url => url.pathname.endsWith('/fetch_session_msgs') ? reply({ messages: [message('101')], ...(hasMore === undefined ? {} : { has_more: hasMore }) }) : undefined
        const before = fs.readFileSync(f.stateFile, 'utf8')
        const r = await f.inbox.poll(); checkFailure(r, hasMore === 1 ? 'dm.history-gap' : 'dm.invalid-data')
        assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before)
      }
    })
    await test('19-digit message sequences and mids remain exact; unsafe numeric sequence is rejected', async () => {
      const before = '1261813571425140745', after = '1261813571425140746'
      const largeMid = '9007199254740993', state = baseState(before)
      state.ownerMid = largeMid; state.cursors[largeMid] = state.cursors[OWNER]; delete state.cursors[OWNER]
      const f = fixture({ state, ownerMid: largeMid })
      f.data.conversations = { [largeMid]: [message(before, 'old', { sender_uid: largeMid }), message(after, 'exact', { sender_uid: largeMid })] }
      const r = await f.inbox.poll(); assert.equal(r.items[0].mid, largeMid); assert.equal(r.items[0].messages[0].seq, after); await f.inbox.ack(r.batchId)
      assert.equal(readJson(f.stateFile).cursors[largeMid].seq, after)
      f.data.override = url => url.pathname.endsWith('/get_sessions') ? reply({ session_list: [{ talker_id: largeMid, last_msg: message('1261813571425140747', 'unsafe', { msg_seq: Number('1261813571425140747') }) }], has_more: 0 }) : undefined
      checkFailure(await f.inbox.poll(), 'dm.unsafe-id')
      assert.equal(readJson(f.stateFile).cursors[largeMid].seq, after)
    })
    await test('explicit BV/link cards need no view lookup; ambiguous or unsafe cards are visibly unsupported', async () => {
      const f = fixture(); f.data.conversations[OWNER] = [old(), card('101', { bvid: BV, title: 'exact' }), card('102', { link: 'https://www.bilibili.com/video/' + BV + '?p=1', title: 'link' }),
        card('103', { bvid: BV, link: 'https://www.bilibili.com/video/' + BV2, title: 'ambiguous' }), card('104', { source: 5, id: Number('1261813571425140745') }), card('105', { url: 'https://evil.invalid/video/' + BV })]
      const r = await f.inbox.poll(); assert.equal(r.hit, true, JSON.stringify(r))
      assert.equal(r.items[0].messages[0].video.bvid, BV); assert.equal(r.items[0].messages[1].video.bvid, BV)
      for (const m of r.items[0].messages.slice(2)) { assert.equal(m.video, undefined); assert.equal(m.error.code, 'dm.unsupported-card'); assert.ok(m.error.hint) }
      assert.equal(f.calls.filter(c => c.url.includes('/view')).length, 0)
    })
    await test('duplicate aid cards share one fixed public view read; mismatched view blocks acknowledgement', async () => {
      const f = fixture(); f.data.conversations[OWNER] = [old(), card(), card('102')]
      const r = await f.inbox.poll(); assert.equal(r.hit, true); assert.equal(f.calls.filter(c => c.url.includes('/view')).length, 1)
      const bad = fixture(); bad.data.conversations[OWNER] = [old(), card()]
      bad.data.override = url => url.pathname.endsWith('/view') ? reply({ aid: '99999', bvid: BV, title: 'wrong' }) : undefined
      checkFailure(await bad.inbox.poll(), 'dm.unsupported-card'); assert.equal(readJson(bad.stateFile).pending, null)
    })
    await test('API, non-JSON, HTTP, network, and redirect failures are sanitized and preserve state', async () => {
      const errors = [
        [() => new Response(JSON.stringify({ code: -352, message: 'DO_NOT_LEAK' })), 'dm.risk-control'],
        [() => new Response(JSON.stringify({ code: -101, message: 'DO_NOT_LEAK' })), 'dm.login-required'],
        [() => new Response(JSON.stringify({ code: -404, message: 'DO_NOT_LEAK' })), 'dm.unavailable'],
        [() => new Response('DO_NOT_LEAK'), 'dm.invalid-json'],
        [() => new Response('DO_NOT_LEAK', { status: 500 }), 'dm.http'],
        [() => { throw new Error('DO_NOT_LEAK') }, 'dm.network'],
        [() => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }), 'dm.redirect'],
        [() => ({ ok: true, status: 200, url: 'https://evil.invalid/', text: async () => '{}' }), 'dm.redirect']
      ]
      for (const [response, code] of errors) {
        const f = fixture(); f.data.override = response; const before = fs.readFileSync(f.stateFile, 'utf8')
        checkFailure(await f.inbox.poll(), code); assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before)
      }
    })
    await test('whole-poll deadline includes hung fetch, body, and cumulative requests', async () => {
      for (const override of [() => new Promise(() => {}), () => ({ ok: true, status: 200, text: () => new Promise(() => {}) })]) {
        const f = fixture({ timeoutMs: 30 }); f.data.override = override
        const start = performance.now(); checkFailure(await f.inbox.poll(), 'dm.timeout'); assert.ok(performance.now() - start < 500)
      }
      const f = fixture({ timeoutMs: 60 }); f.data.override = async url => { await new Promise(r => setTimeout(r, url.pathname.endsWith('/get_sessions') ? 35 : 45)); return undefined }
      const start = performance.now(); checkFailure(await f.inbox.poll(), 'dm.timeout'); assert.ok(performance.now() - start < 300)
    })
    await test('parallel polls and acknowledgements converge without losing an unacknowledged batch', async () => {
      const f = fixture(); f.data.override = async () => { await new Promise(r => setTimeout(r, 3)); return undefined }
      const [a, b] = await Promise.all([f.inbox.poll(), createDmInbox(f.settings).poll()])
      assert.equal(a.hit, true); assert.equal(b.batchId, a.batchId); assert.equal(readJson(f.stateFile).cursors[OWNER].seq, '100')
      const [aa, bb] = await Promise.all([f.inbox.ack(a.batchId), createDmInbox(f.settings).ack(a.batchId)])
      assert.equal(aa.acked, true); assert.equal(bb.acked, true); assert.ok(aa.alreadyAcked || bb.alreadyAcked)
      assert.equal(readJson(f.stateFile).cursors[OWNER].seq, '101'); assert.equal(fs.existsSync(f.stateFile + '.lock'), false)
    })
    await test('live lock and corrupt state fail visibly; baseline cannot discard pending input', async () => {
      const f = fixture(); saveJson(f.stateFile + '.lock', { pid: process.pid })
      checkFailure(await f.inbox.poll(), 'dm.state-busy'); fs.unlinkSync(f.stateFile + '.lock')
      saveJson(f.stateFile + '.lock', { pid: 2147483647 })
      checkFailure(await f.inbox.poll(), 'dm.state-busy'); assert.equal(readJson(f.stateFile + '.lock').pid, 2147483647)
      fs.unlinkSync(f.stateFile + '.lock')
      const r = await f.inbox.poll(); checkFailure(await f.inbox.poll({ baseline: true }), 'dm.pending-batch')
      assert.equal(readJson(f.stateFile).pending.batchId, r.batchId)
      fs.writeFileSync(f.stateFile, '{invalid DO_NOT_LEAK')
      checkFailure(await f.inbox.poll(), 'dm.state-invalid')
    })
    await test('valid JSON with corrupt pending identity or cursor cannot replay or acknowledge', async () => {
      for (const corrupt of [state => { state.pending.cursors[OWNER].seq = Number('1261813571425140745') }, state => { state.pending.cursors[OWNER].seq = '99' }, state => { state.pending.items[0].isOwner = false }, state => { state.pending.items[0].messages = [] }]) {
        const f = fixture(), batch = await f.inbox.poll(), saved = readJson(f.stateFile)
        corrupt(saved); saveJson(f.stateFile, saved)
        const before = fs.readFileSync(f.stateFile, 'utf8'), calls = f.calls.length
        checkFailure(await f.inbox.poll(), 'dm.state-invalid'); checkFailure(await f.inbox.ack(batch.batchId), 'dm.state-invalid')
        assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before); assert.equal(f.calls.length, calls)
      }
    })
    await test('outgoing-only scan advances after full history; own latest never bypasses a gap', async () => {
      const f = fixture(); f.data.conversations[OWNER] = [old(), message('101', 'own', { sender_uid: SELF, receiver_id: OWNER })]
      const r = await f.inbox.poll(); assert.equal(r.hit, false); assert.equal(readJson(f.stateFile).cursors[OWNER].seq, '101')
      f.data.conversations[OWNER] = [message('103', 'own', { sender_uid: SELF, receiver_id: OWNER })]
      checkFailure(await f.inbox.poll(), 'dm.history-gap'); assert.equal(readJson(f.stateFile).cursors[OWNER].seq, '101')
    })
    await test('actual CLI replay uses fixture files, stable pending batch, ack, and credential-free repeated ack', async () => {
      const dir = path.join(root, 'cli'), dsh = path.join(dir, 'dsh'), bili = path.join(dsh, 'surfcore', 'bili')
      const configFile = path.join(dsh, 'surfcore', 'bili.config.json'), fixtureFile = path.join(dir, 'fixture.json')
      saveJson(configFile, { owner: { mid: OWNER, name: 'fixture' }, self: { mid: SELF } })
      saveJson(path.join(bili, 'credentials.json'), { sessdata: 'offline-fixture-only' })
      saveJson(path.join(bili, 'dm-await-state.json'), baseState())
      saveJson(fixtureFile, { conversations: { [OWNER]: [old(), card(), message('102', 'share request')] } })
      const invoke = args => {
        const stdout = path.join(dir, 'stdout.txt'), stderr = path.join(dir, 'stderr.txt')
        const outFd = fs.openSync(stdout, 'w'), errFd = fs.openSync(stderr, 'w')
        let child
        try { child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--fixture-cli', fixtureFile, ...args], { env: { ...process.env, DSH_HOME: dsh, SURFCORE_BILI_CONFIG: configFile }, stdio: ['ignore', outFd, errFd], timeout: 5000 }) }
        finally { fs.closeSync(outFd); fs.closeSync(errFd) }
        assert.equal(child.error, undefined); assert.equal(fs.readFileSync(stderr, 'utf8'), '')
        return { status: child.status, result: JSON.parse(fs.readFileSync(stdout, 'utf8')) }
      }
      let childIndex = 0
      const invokeConcurrent = async args => {
        const index = ++childIndex, stdout = path.join(dir, 'parallel-' + index + '.txt'), stderr = path.join(dir, 'parallel-' + index + '-err.txt')
        const outFd = fs.openSync(stdout, 'w'), errFd = fs.openSync(stderr, 'w')
        let status
        try {
          status = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture-cli', fixtureFile, ...args], { env: { ...process.env, DSH_HOME: dsh, SURFCORE_BILI_CONFIG: configFile }, stdio: ['ignore', outFd, errFd], timeout: 5000 })
            child.once('error', reject); child.once('close', resolve)
          })
        } finally { fs.closeSync(outFd); fs.closeSync(errFd) }
        assert.equal(fs.readFileSync(stderr, 'utf8'), '')
        return { status, result: JSON.parse(fs.readFileSync(stdout, 'utf8')) }
      }
      const [first, competing] = await Promise.all([invokeConcurrent(['--once', '--json']), invokeConcurrent(['--once', '--json'])])
      assert.equal(first.status, 0); assert.equal(first.result.hit, true); assert.equal(competing.result.batchId, first.result.batchId)
      assert.equal(first.result.items[0].messages[0].video.bvid, BV)
      const repeat = invoke(['--once', '--json']); assert.equal(repeat.result.batchId, first.result.batchId)
      fs.unlinkSync(path.join(bili, 'credentials.json'))
      const acknowledgements = await Promise.all([invokeConcurrent(['--ack', first.result.batchId, '--json']), invokeConcurrent(['--ack', first.result.batchId, '--json'])])
      for (const ack of acknowledgements) { assert.equal(ack.status, 0); assert.equal(ack.result.acked, true) }
      assert.ok(acknowledgements.some(ack => ack.result.alreadyAcked))
      assert.equal(invoke(['--ack', first.result.batchId, '--json']).result.alreadyAcked, true)
      const missing = invoke(['--once', '--json']); assert.equal(missing.status, 3); checkFailure(missing.result, 'dm.configuration')
    })
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log(passed + ' passed; ' + failed + ' failed')
  process.exitCode = failed ? 1 : 0
}
