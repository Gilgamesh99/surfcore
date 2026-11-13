// Durable private-message intake. Poll never acknowledges delivery; use --ack <batchId>.
import fs from 'node:fs'
import { accountBili, biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { createDmInbox } from '../lib/dm-inbox.mjs'

const argv = process.argv.slice(2), opt = {}
let result
try {
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (['--once', '--json', '--any', '--owner', '--baseline'].includes(key)) opt[key.slice(2)] = true
    else if (key === '--ack' && argv[i + 1] && !argv[i + 1].startsWith('--')) opt.ack = argv[++i]
    else throw new Error('arguments')
  }
  if ((opt.any && opt.owner) || (opt.ack && opt.baseline)) throw new Error('arguments')
  const cfg = config()
  const options = { stateFile: biliState('dm-await-state.json'), ownerMid: cfg.owner?.mid, ownerName: cfg.owner?.name, selfMid: cfg.self?.mid }
  if (!opt.ack) {
    let credentials
    try { credentials = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8')) }
    catch { throw new Error('credentials') }
    if (typeof credentials.sessdata !== 'string' || !credentials.sessdata) throw new Error('credentials')
    options.headers = {
      'user-agent': 'SurfCore/1.0', referer: 'https://www.bilibili.com/',
      cookie: [['SESSDATA', credentials.sessdata], ['bili_jct', credentials.bili_jct || ''], ['buvid3', credentials.buvid3 || '']].map(pair => pair.join('=')).join('; ')
    }
  }
  const inbox = createDmInbox(options)
  result = opt.ack ? await inbox.ack(opt.ack) : await inbox.poll({ any: !!opt.any, baseline: !!opt.baseline })
} catch (error) {
  const args = error.message === 'arguments'
  result = { ok: false, hit: false, items: [], code: args ? 'dm.arguments' : 'dm.configuration',
    error: args ? '私信命令参数无效。' : '私信读取缺少有效配置或登录凭据。',
    hint: args ? '使用 --once --json [--any]、--ack <batchId> --json 或 --baseline --json；baseline 不可替代交付确认。' : '检查 B站账号配置并重新登录；不会自动重置已保存水位。' }
}
if (opt.json || argv.includes('--json')) console.log(JSON.stringify(result))
else if (!result.ok) console.error(result.code + ': ' + result.error + ' ' + result.hint)
else if (result.acked) console.log('已确认私信批次 ' + result.batchId)
else if (result.hit) console.log('DM_HIT batchId=' + result.batchId + ' ' + JSON.stringify(result.items))
else console.log(result.baseline ? '已建立当前私信基线。' : '无新私信。')
process.exitCode = !result.ok ? 3 : result.hit || result.acked || result.baseline ? 0 : 1
