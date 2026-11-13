// Offline behavioral tests: fake fetch only, no files, credentials, sockets or writes.
// Run: node plugins/surfcore/scripts/test-bili-dynamic-reader.mjs
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createDynamicReader, dynamicIdFrom, formatDynamicRead } from '../tools/lib/dynamic-reader.mjs'

const OUTER = '1261813571425140745'
const ORIGINAL = '1261747890123456789'
const THIRD = '1261600000000000001'
const OUTER_OID = '2261813571425140745'
const ORIGINAL_OID = '2261747890123456789'
const PRIVATE = 'fixture-private-header-value'
const IMG = '7cd084941338484aae1ad9425b84077c'
const SUB = '4932caff0ff746eab6f01bf08b70ac45'
const KEY = 'ea1db124af3c7062474693fa704f4ff8' // Independent known WBI test vector.
const NAV = { code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png` } } }
const violations = []
const realFetch = globalThis.fetch
globalThis.fetch = () => { violations.push('unexpected global fetch'); throw new Error('real network forbidden') }
after(() => { globalThis.fetch = realFetch; assert.deepEqual(violations, []) })

function post(id = OUTER, text = '普通动态正文', { type = 'DYNAMIC_TYPE_WORD', major = null, original, basic, author } = {}) {
  const item = {
    id_str: id, type, basic: basic ?? { comment_id_str: id === OUTER ? OUTER_OID : ORIGINAL_OID, comment_type: 17 },
    modules: { module_author: author ?? { name: '离线作者', mid: 12345 }, module_dynamic: { desc: text === null ? null : { text }, major } },
  }
  if (original !== undefined) item.orig = original
  return item
}
const response = (json, status = 200, extra = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json, ...extra })
function fixture({ items = { [OUTER]: post() }, nav = () => response(NAV), detail } = {}) {
  const calls = []
  const fetchImpl = async (address, options) => {
    const url = new URL(address)
    calls.push({ url, options })
    try {
      assert.equal(url.origin, 'https://api.bilibili.com')
      assert.ok(['/x/web-interface/nav', '/x/polymer/web-dynamic/v1/detail'].includes(url.pathname))
      assert.equal(options.method, 'GET')
      assert.equal(options.redirect, 'manual')
      assert.equal(options.body, undefined)
      assert.ok(options.signal instanceof AbortSignal)
    } catch (error) { violations.push('non-readonly request'); throw error }
    if (url.pathname.endsWith('/nav')) return nav(url, options)
    assert.equal(url.searchParams.get('features'), 'itemOpusStyle')
    assert.match(url.searchParams.get('id'), /^[1-9]\d{0,19}$/)
    const query = address.split('?')[1].split('&w_rid=')[0]
    assert.equal(url.searchParams.get('w_rid'), createHash('md5').update(query + KEY).digest('hex'))
    assert.match(url.searchParams.get('wts'), /^\d+$/)
    return detail ? detail(url, options) : response({ code: 0, data: { item: items[url.searchParams.get('id')] } })
  }
  return { calls, fetchImpl, read: options => createDynamicReader({ fetchImpl, ...options }) }
}
function failed(result, code) {
  assert.equal(result.ok, false)
  assert.equal(result.code, `dynamic.${code}`)
  assert.ok(result.error.length > 0)
  assert.ok(result.hint.length > 0)
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
}
function repost() {
  return post(OUTER, '@小鲸鱼', { type: 'DYNAMIC_TYPE_FORWARD', original: post(ORIGINAL, null, {
    major: { type: 'MAJOR_TYPE_OPUS', opus: { summary: { text: '被转发的原文，desc 为 null 时仍应读取。' }, pics: [{ url: 'https://i0.hdslb.com/original.jpg' }] } },
    author: { name: '原文作者', mid: 54321 },
  }) })
}

test('string IDs and supported URLs preserve all 19 digits; unsafe and unrelated inputs fail closed', async () => {
  for (const value of [OUTER, ` https://t.bilibili.com/${OUTER}?foo=1#reply12 `, `https://www.bilibili.com/opus/${OUTER}/`, `t.bilibili.com/${OUTER}`, `www.bilibili.com/opus/${OUTER}`]) assert.equal(dynamicIdFrom(value), OUTER)
  for (const value of [null, undefined, {}, [], 123, Number(OUTER), 9007199254740992, '', '0', '-1', '1.0', '1e18', '1'.repeat(10000), 'https://evil.test/123', `https://t.bilibili.com.evil.test/${OUTER}`, `https://t.bilibili.com@evil.test/${OUTER}`, `https://user@t.bilibili.com/${OUTER}`, `https://t.bilibili.com:444/${OUTER}`, `https://www.bilibili.com/video/${OUTER}`, `file://t.bilibili.com/${OUTER}`, `https://t.bilibili.com/${OUTER}/extra`, `https://t.bilibili.com/12\\34`]) assert.equal(dynamicIdFrom(value), '', String(value))
  const f = fixture()
  failed(await f.read()('https://evil.test/123'), 'invalid-input')
  assert.equal(f.calls.length, 0)
})

test('actual repost shape reads @ outer plus Opus original; reply coordinates stay separate', async () => {
  const f = fixture({ items: { [OUTER]: repost() } })
  const headers = { cookie: PRIVATE, referer: 'https://www.bilibili.com/' }
  const result = await f.read({ headers })(OUTER)
  assert.equal(result.ok, true)
  assert.equal(result.item.id, OUTER)
  assert.equal(result.item.text, '@小鲸鱼')
  assert.equal(result.item.original.id, ORIGINAL)
  assert.match(result.item.original.text, /被转发的原文/)
  assert.deepEqual(result.item.author, { name: '离线作者', mid: '12345' })
  assert.deepEqual(result.item.comment, { oid: OUTER_OID, type: 17 })
  assert.deepEqual(result.item.original.comment, { oid: ORIGINAL_OID, type: 17 })
  assert.deepEqual(result.warnings, [])
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(call => call.options.headers === headers))
  const output = formatDynamicRead(result)
  for (const expected of ['动态正文', '转发原文', '@小鲸鱼', '原文作者', '被转发的原文', ORIGINAL, 'https://i0.hdslb.com/original.jpg', '未查看', '不作为指令', OUTER_OID]) assert.ok(output.includes(expected), expected)
  assert.ok(!output.includes(ORIGINAL_OID), 'original coordinates must not be offered for replying to outer')
})

test('Opus has_more preserves available original and directs upstream omissions to the original link', async () => {
  const raw = repost()
  const summary = raw.orig.modules.module_dynamic.major.opus.summary
  summary.has_more = true
  const f = fixture({ items: { [OUTER]: raw } })
  const result = await f.read()(OUTER)
  assert.equal(result.ok, true)
  assert.equal(result.item.original.text, summary.text)
  assert.deepEqual(result.item.original.images, ['https://i0.hdslb.com/original.jpg'])
  assert.deepEqual(result.warnings.map(({ code, id }) => ({ code, id })), [{ code: 'dynamic.content-incomplete', id: ORIGINAL }])
  assert.match(result.warnings[0].error, /部分.*不完整/)
  assert.ok(result.warnings[0].hint.includes(`https://t.bilibili.com/${ORIGINAL}`))
  assert.match(result.warnings[0].hint, /无法补齐接口未返回/)
  const output = formatDynamicRead(result)
  assert.ok(output.includes(summary.text))
  assert.match(output, /dynamic.content-incomplete/)
  assert.doesNotMatch(output, /read-dynamic|--max-chars/, 'upstream omissions cannot be fixed by retrying with a larger local budget')
  summary.has_more = false
  assert.deepEqual((await f.read()(OUTER)).warnings, [])
})

test('normal desc, draw pictures and rich text fallback survive without invented vision', async () => {
  const raw = post(OUTER, '正文与图片', { major: { draw: { items: [{ src: '//i0.hdslb.com/one.png' }, { src: 'https://i0.hdslb.com/two.jpg' }, { src: 'javascript:alert(1)' }] } } })
  const f = fixture({ items: { [OUTER]: raw } })
  const result = await f.read()(OUTER)
  assert.deepEqual(result.item.images, ['https://i0.hdslb.com/one.png', 'https://i0.hdslb.com/two.jpg'])
  assert.equal(result.item.original, null)
  assert.match(formatDynamicRead(result), /图片链接（未查看）/)
  raw.modules.module_dynamic.desc = { text: null, rich_text_nodes: [{ text: '@朋友' }, { orig_text: ' 富文本回退正文' }] }
  const rich = await f.read()(OUTER)
  assert.equal(rich.item.text, '@朋友 富文本回退正文')
})

test('video original includes title and description but no video-content claims', async () => {
  const video = post(ORIGINAL, null, { type: 'DYNAMIC_TYPE_AV', major: { archive: { title: '离线视频标题', desc: '这是视频简介', cover: 'https://i0.hdslb.com/cover.jpg' } }, basic: { comment_id: 98765, comment_type: 1 } })
  const result = await fixture({ items: { [OUTER]: post(OUTER, '@小鲸鱼', { type: 'DYNAMIC_TYPE_FORWARD', original: video }) } }).read()(OUTER)
  assert.match(result.item.original.text, /视频标题：离线视频标题/)
  assert.match(result.item.original.text, /视频简介：这是视频简介/)
  assert.deepEqual(result.item.original.comment, { oid: '98765', type: 1 })
  assert.match(formatDynamicRead(result), /离线视频标题/)
})

test('nested reposts show available originals and a deleted-original reason', async () => {
  const deleted = { id_str: THIRD, type: 'DYNAMIC_TYPE_NONE', modules: { module_dynamic: { major: { type: 'MAJOR_TYPE_NONE', none: { tips: '源动态已被删除' } } } } }
  const nested = post(ORIGINAL, '第二层转发', { type: 'DYNAMIC_TYPE_FORWARD', original: deleted })
  const result = await fixture({ items: { [OUTER]: post(OUTER, '@小鲸鱼', { type: 'DYNAMIC_TYPE_FORWARD', original: nested }) } }).read()(OUTER)
  assert.equal(result.item.original.text, '第二层转发')
  assert.equal(result.item.original.original, null)
  assert.equal(result.warnings[0].code, 'dynamic.deleted')
  assert.equal(result.warnings[0].id, THIRD)
  assert.match(formatDynamicRead(result), /转发原文.*已删除/)
  assert.ok(formatDynamicRead(result).includes(`read-dynamic --id ${THIRD}`))
})

test('missing original is explicit; a precise original reference is fetched once', async () => {
  const missing = post(OUTER, '@小鲸鱼', { type: 'DYNAMIC_TYPE_FORWARD' })
  const absent = await fixture({ items: { [OUTER]: missing } }).read()(OUTER)
  assert.equal(absent.warnings[0].code, 'dynamic.original-unavailable')
  assert.match(formatDynamicRead(absent), /转发原文.*接口未提供/)
  const referenced = post(OUTER, '@小鲸鱼', { type: 'DYNAMIC_TYPE_FORWARD', original: { id_str: ORIGINAL } })
  const f = fixture({ items: { [OUTER]: referenced, [ORIGINAL]: post(ORIGINAL, '补读原文') } })
  const read = f.read()
  assert.equal((await read(OUTER)).item.original.text, '补读原文')
  assert.equal((await read(ORIGINAL)).item.text, '补读原文')
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/detail')).length, 2)
})

test('original lookup failure remains a warning on the readable outer post', async () => {
  const f = fixture({ detail: url => response(url.searchParams.get('id') === OUTER ? { code: 0, data: { item: post(OUTER, '@小鲸鱼', { type: 'DYNAMIC_TYPE_FORWARD', original: { id_str: ORIGINAL } }) } } : { code: -352, message: PRIVATE }) })
  const result = await f.read()(OUTER)
  assert.equal(result.ok, true)
  assert.equal(result.item.original, null)
  assert.equal(result.warnings[0].code, 'dynamic.risk-control')
  assert.match(result.warnings[0].hint, /read-dynamic/)
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
})

test('depth and cycle limits are explicit and actionable', async () => {
  const root = repost()
  root.orig.type = 'DYNAMIC_TYPE_FORWARD'
  root.orig.orig = post(THIRD, '第三层')
  const limited = await fixture({ items: { [OUTER]: root } }).read({ maxDepth: 1 })(OUTER)
  assert.equal(limited.item.original.original, null)
  assert.equal(limited.warnings[0].code, 'dynamic.depth-limit')
  assert.equal(limited.warnings[0].id, THIRD)
  assert.ok(formatDynamicRead(limited).includes(`read-dynamic --id ${THIRD}`))
  root.orig.orig = root
  const cycled = await fixture({ items: { [OUTER]: root } }).read()(OUTER)
  assert.equal(cycled.warnings[0].code, 'dynamic.cycle')
  assert.equal(cycled.item.original.original, null)
  const shallow = await fixture({ items: { [OUTER]: root } }).read({ maxDepth: 0 })(OUTER)
  assert.equal(shallow.item.original, null)
  assert.equal(shallow.warnings[0].code, 'dynamic.depth-limit')
})

test('precision-safe comments never fall back to dynamic ID or original coordinates', async () => {
  for (const basic of [{ comment_id: Number(OUTER_OID), comment_type: 17 }, {}, { comment_id_str: 'bad', comment_id: Infinity, comment_type: Number.MAX_SAFE_INTEGER + 1 }]) {
    const root = repost(); root.basic = basic
    const result = await fixture({ items: { [OUTER]: root } }).read()(OUTER)
    assert.equal(result.item.comment.oid, '')
    assert.equal(result.item.comment.type, basic.comment_type === 17 ? 17 : null)
  }
  const safe = await fixture({ items: { [OUTER]: post(OUTER, '安全后备', { basic: { comment_id: 123, comment_type: '11' }, author: { name: '作者', mid: Number(ORIGINAL) } }) } }).read()(OUTER)
  assert.deepEqual(safe.item.comment, { oid: '123', type: 11 })
  assert.equal(safe.item.author.mid, '')
})

test('concurrent aliases and later calls share detail promises and one signing key', async () => {
  const f = fixture({ items: { [OUTER]: post(), [ORIGINAL]: post(ORIGINAL, '另一个动态') } })
  const read = f.read()
  const results = await Promise.all([read(OUTER), read(`https://www.bilibili.com/opus/${OUTER}`), read(ORIGINAL), read(OUTER)])
  assert.ok(results.every(result => result.ok))
  assert.equal(results[0], results[1])
  assert.equal(await read(OUTER), results[0])
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/nav')).length, 1)
})

test('nav errors are classified and sanitized, including malformed signing data', async () => {
  for (const [nav, code] of [
    [() => response({ code: -352, message: PRIVATE }), 'risk-control'],
    [() => response({ code: -101, message: PRIVATE }), 'login-required'],
    [() => response({ code: 0, data: {} }), 'signing-unavailable'],
    [() => response(null), 'invalid-json'],
    [() => response(null, 200, { json: async () => { throw new Error(PRIVATE) } }), 'invalid-json'],
    [() => { throw new Error(PRIVATE) }, 'network'],
  ]) {
    const f = fixture({ nav })
    failed(await f.read({ headers: { cookie: PRIVATE } })(OUTER), code)
    assert.equal(f.calls.length, 1)
  }
  const guest = await fixture({ nav: () => response({ ...NAV, code: -101 }) }).read()(OUTER)
  assert.equal(guest.ok, true)
})

test('detail API risk, login, deleted, unavailable and missing item failures are distinct', async () => {
  for (const [apiCode, code] of [[-352, 'risk-control'], [-412, 'risk-control'], [-509, 'risk-control'], [-101, 'login-required'], [-404, 'deleted'], [-403, 'unavailable'], [-500, 'api']]) {
    failed(await fixture({ detail: () => response({ code: apiCode, message: PRIVATE }) }).read()(OUTER), code)
  }
  failed(await fixture({ detail: () => response({ code: 0, data: {} }) }).read()(OUTER), 'missing-item')
  failed(await fixture({ detail: () => response({ code: 0, data: { item: { id_str: OUTER } } }) }).read()(OUTER), 'missing-item')
  failed(await fixture({ detail: () => response({ code: 0, data: { item: post(ORIGINAL) } }) }).read()(OUTER), 'item-mismatch')
  failed(await fixture({ detail: () => response(null, 200, { json: async () => { throw new SyntaxError(PRIVATE) } }) }).read()(OUTER), 'invalid-json')
})

test('HTTP and redirects fail safely without fetching a different origin', async () => {
  for (const [status, code] of [[401, 'login-required'], [403, 'unavailable'], [404, 'deleted'], [429, 'risk-control'], [500, 'http'], [302, 'redirect-blocked']]) {
    const f = fixture({ detail: () => response(null, status, { headers: { location: `https://evil.test/${PRIVATE}` } }) })
    failed(await f.read({ headers: { cookie: PRIVATE } })(OUTER), code)
    assert.equal(f.calls.length, 2)
  }
  for (const extra of [{ redirected: true }, { url: `https://evil.test/${PRIVATE}` }]) failed(await fixture({ detail: () => response({}, 200, extra) }).read()(OUTER), 'redirect-blocked')
})

test('hung fetch and hung response bodies are bounded even if fetch ignores AbortSignal', async () => {
  for (const options of [
    { nav: () => new Promise(() => {}) },
    { nav: () => response(null, 200, { json: () => new Promise(() => {}) }) },
    { detail: () => new Promise(() => {}) },
    { detail: () => response(null, 200, { json: () => new Promise(() => {}) }) },
  ]) {
    const f = fixture(options)
    const started = Date.now()
    failed(await f.read({ timeoutMs: 20 })(OUTER), 'timeout')
    assert.ok(Date.now() - started < 1500)
    await delay(1)
    assert.ok(f.calls.every(call => call.options.signal.aborted))
  }
})

test('one deadline covers navigation plus detail body, rather than restarting the budget', async () => {
  const f = fixture({ nav: async () => { await delay(35); return response(NAV) }, detail: () => response(null, 200, { json: async () => { await delay(45); return { code: 0, data: { item: post() } } } }) })
  failed(await f.read({ timeoutMs: 60 })(OUTER), 'timeout')
  const f2 = fixture({ nav: () => response(null, 200, { json: async () => { await delay(35); return NAV } }), detail: async () => { await delay(45); return response({ code: 0, data: { item: post() } }) } })
  failed(await f2.read({ timeoutMs: 60 })(OUTER), 'timeout')
})

test('reader bounds enormous fields, rich nodes, pictures and deep chains', async () => {
  let chain = post('1010', '末层')
  for (let index = 9; index >= 0; index--) chain = post(index === 0 ? OUTER : String(1000 + index), '长'.repeat(100000), { type: 'DYNAMIC_TYPE_FORWARD', original: chain, author: { name: '名'.repeat(10000), mid: 1 }, major: { opus: { pics: Array.from({ length: 100 }, (_, n) => ({ url: `https://i0.hdslb.com/${n}.jpg` })) } } })
  const result = await fixture({ items: { [OUTER]: chain } }).read({ maxDepth: 100 })(OUTER)
  assert.equal(result.ok, true)
  let item = result.item, count = 0
  while (item) { assert.ok(item.text.length <= 32000); assert.ok(item.images.length <= 24); assert.ok(item.author.name.length <= 160); count++; item = item.original }
  assert.equal(count, 9)
  assert.ok(result.warnings.some(warning => warning.code === 'dynamic.depth-limit'))
  assert.ok(result.warnings.some(warning => warning.code === 'dynamic.fields-truncated'))
  assert.ok(result.warnings.some(warning => warning.code === 'dynamic.images-truncated'))
})

test('multiline text cannot crowd out image links or original content', async () => {
  const result = await fixture({ items: { [OUTER]: repost() } }).read()(OUTER)
  result.item.text = '多行\n'.repeat(4000)
  result.item.images = ['https://i0.hdslb.com/outer.png']
  result.item.original.text = '原文可见\n' + '另一行\n'.repeat(4000)
  const output = formatDynamicRead(result)
  assert.ok(output.length <= 6000)
  for (const text of ['原文可见', 'https://i0.hdslb.com/outer.png', 'https://i0.hdslb.com/original.jpg', '内容已截断', 'read-dynamic']) assert.ok(output.includes(text), text)
  const raw = post()
  raw.modules.module_dynamic.desc = { rich_text_nodes: [{ text: '文'.repeat(32000) }, { text: '额外文本' }] }
  const capped = await fixture({ items: { [OUTER]: raw } }).read()(OUTER)
  assert.equal(capped.item.text.length, 32000)
  assert.equal(capped.warnings[0].code, 'dynamic.fields-truncated')
})

test('truncation preserves well-formed Unicode in extracted text and every prompt budget', async () => {
  const raw = post(OUTER, '文'.repeat(31999) + '🐋', { author: { name: '名'.repeat(159) + '🐟', mid: 12345 } })
  const result = await fixture({ items: { [OUTER]: raw } }).read()(OUTER)
  assert.equal(result.ok, true)
  assert.ok(result.item.text.isWellFormed(), 'API text truncated in the middle of an emoji must remain valid Unicode')
  assert.ok(result.item.author.name.isWellFormed(), 'author truncation must remain valid Unicode')
  assert.ok(!result.item.text.includes('�'), 'a partial final emoji should be omitted without a replacement character')
  result.item.text = '🐋😀\n'.repeat(2000)
  result.item.author.name = '鱼🐟'.repeat(70)
  for (let maxChars = 1; maxChars <= 1600; maxChars++) {
    const output = formatDynamicRead(result, { maxChars })
    assert.ok(output.isWellFormed(), 'prompt Unicode at budget ' + maxChars)
    assert.ok(output.length <= maxChars)
  }
})

test('formatter reserves space for originals and visibly bounds hostile fields and cyclic chains', async () => {
  const result = await fixture({ items: { [OUTER]: repost() } }).read()(OUTER)
  result.item.text = '外'.repeat(100000)
  result.item.original.text = 'ORIGINAL_VISIBLE\n' + '原'.repeat(100000)
  result.item.images = Array.from({ length: 100 }, (_, index) => `https://i0.hdslb.com/${index}.jpg`)
  const output = formatDynamicRead(result)
  assert.ok(output.length <= 6000)
  assert.match(output, /ORIGINAL_VISIBLE/)
  assert.match(output, /内容已截断/)
  assert.ok(output.includes(`read-dynamic --id ${OUTER} --max-chars 12000`))
  for (const maxChars of [0, 1, 40, 100, 300, 512, 1000, 6000]) assert.ok(formatDynamicRead(result, { maxChars }).length <= maxChars)
  result.item.original.original = result.item
  assert.match(formatDynamicRead(result), /循环原文/)
  result.item.author.name = '巨大作者'.repeat(10000)
  result.warnings = Array.from({ length: 10000 }, () => ({ code: 'c'.repeat(10000), error: 'e'.repeat(10000), hint: 'h'.repeat(10000) }))
  assert.ok(formatDynamicRead(result, { maxChars: 1000 }).length <= 1000)
  assert.ok(formatDynamicRead({ ok: false, code: 'x'.repeat(10000), error: 'e'.repeat(10000), hint: 'h'.repeat(10000) }, { maxChars: 200 }).length <= 200)
})
