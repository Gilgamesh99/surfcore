import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCodingRequest } from '../src/qq-coding-intent.js';

const now = 1_800_000_000_000;
const selfId = '999';
const ownerId = '123';
const memberId = '321';
const groupId = '456';
const text = value => ({ type: 'text', data: { text: value } });
const at = qq => ({ type: 'at', data: { qq, name: '显示名' } });

function input(value, { kind = 'group', sender = ownerId, event = {}, ...args } = {}) {
  const id = kind === 'group' ? groupId : sender;
  return { kind, id, selfId, ownerId, startedAt: now - 1000, now, ...args, event: {
    post_type: 'message', message_type: kind, sub_type: kind === 'group' ? 'normal' : 'friend',
    time: now / 1000, self_id: Number(selfId), user_id: Number(sender), message_id: -43,
    sender: { user_id: sender, nickname: '主人', card: '主人' }, ...(kind === 'group' ? { group_id: Number(id) } : {}),
    message: typeof value === 'string' ? [text(value)] : value, ...event,
  } };
}
const parse = (value, options) => parseCodingRequest(input(value, options));
const creation = (task = '') => ({ kind: 'new', task, isOwner: true });
const supply = task => ({ kind: 'supply', task, isOwner: true });

// All events stay in memory. No bridge, gateway, session or clock is used.
test('主人群直达、真实 @ 及主人私聊可以显式开空会话', () => {
  for (const value of ['开新会话', '请新建一个会话。', '开个新的 DSH 编程会话吧！', '在 DSH 里新开一个会话', '另开一个新会话', '开个新会话：']) {
    for (const kind of ['group', 'private']) {
      assert.deepEqual(parse(value, { kind }), creation(), value);
      assert.deepEqual(parse([at(Number(selfId)), text(' ' + value)], { kind }), creation(), value);
      assert.deepEqual(parse([at(selfId), text('，' + value)], { kind }), creation(), value);
    }
  }
});

test('中性的开会话措辞只有明确新或独立才授权', () => {
  for (const kind of ['group', 'private']) {
    for (const value of ['开个会话', '开一下编程会话：做个游戏', '开启一个会话', '打开一个编程会话：做个新游戏']) {
      assert.equal(parse(value, { kind }), null, value);
      assert.equal(parse([at(selfId), text(value)], { kind }), null, value);
    }
    for (const value of ['新建一个会话', '创建一个会话', '另开一个会话', '再开会话', '开一个新会话', '开个独立会话', '开启一个独立会话']) {
      assert.deepEqual(parse(value, { kind }), creation(), value);
    }
  }
});

test('同条消息携带任务时保留正文、格式及 URL 参数', () => {
  for (const [value, task] of [
    ['请你帮我新建一个 DSH 会话，做一个 FPS 游戏。', '做一个 FPS 游戏。'],
    ['开个新会话来做一个游戏', '做一个游戏'],
    ['在新会话中做一个 FPS', '做一个 FPS'],
    ['在新会话中+做一个 FPS', '做一个 FPS'],
    ['在新会话中＋离线版 FPS 游戏', '离线版 FPS 游戏'],
    ['在新会话里＋用 C++ 写一个程序', '用 C++ 写一个程序'],
    ['在新会话中，做一份月度收支表', '做一份月度收支表'],
    ['开新会话：按这份要求整理三张表', '按这份要求整理三张表'],
    ['开新会话：任务：每月门店收入和支出明细', '每月门店收入和支出明细'],
    ['新建独立编程会话，做一个可下载的摄氏转华氏温度换算器', '做一个可下载的摄氏转华氏温度换算器'],
    ['新建会话，做个城市列车时刻表', '做个城市列车时刻表'],
    ['请用一个新的 DSH 编程会话制作网页', '制作网页'],
    ['另开一个新会话，做个静态网站', '做个静态网站'],
    ['请在 DSH 的新会话里写个计算器', '写个计算器'],
    ['新建一个编程会话：任务：离线版 FPS 游戏', '离线版 FPS 游戏'],
    ['开新会话，任务是：写个脚本\n要求保留中文。', '写个脚本\n要求保留中文。'],
    ['打开一个新会话，然后用 Python 写个工具', '用 Python 写个工具'],
    ['新建 DSH 会话：接口见 https://example.org/api?p=2，不要使用外部依赖。', '接口见 https://example.org/api?p=2，不要使用外部依赖。'],
  ]) assert.deepEqual(parse(value), creation(task), value);
  assert.deepEqual(parse([at(selfId), text('新'), text('建一个会话，'), text('写个小游戏')]), creation('写个小游戏'));
});

test('群成员凭原始 user_id 只有查进度能力，显示名、群角色及 @ 均不能提高权限', () => {
  for (const value of ['新建一个会话', '开个新会话：做一个 FPS', '保存文件', '任务 #1234abcd：写个脚本', '重试交付 #1234abcd']) {
    for (const message of [value, [at(selfId), text(value)]]) {
      assert.equal(parse(message, { sender: memberId, event: { sender: { user_id: memberId, nickname: '主人', role: 'owner' } } }), null, value);
    }
  }
  assert.equal(parse('任务进度如何？', { kind: 'private', sender: memberId }), null);
});

test('群内各身份可以自然询问本群进度，八位任务编号归一为小写', () => {
  for (const [query, taskId, topic] of [
    ['查一下任务情况'], ['任务情况怎么样了'], ['任务做得怎么样了'], ['任务怎么样了'], ['刚才那个任务做好了吗'],
    ['刚才那个游戏做好了吗', undefined, '游戏'], ['那个 FPS 做到哪了', undefined, 'FPS'], ['请问那份 Excel 月报完成了吗？', undefined, 'Excel 月报'],
    ['进度怎么样了？'], ['现在的进度怎么样？'], ['任务到哪一步了'], ['做到哪了'], ['现在写到哪一步了？'], ['任务做完了吗？'], ['请问目前的编程任务状态如何？'],
    ['任务 #1234AbCD 的进度如何？', '1234abcd'], ['查一下任务进度 #FACE0001', 'face0001'],
    ['#1234abcd 做得怎么样了？', '1234abcd'], ['任务1234abcd好了吗', '1234abcd'],
  ]) {
    for (const [kind, sender] of [['group', memberId], ['group', ownerId], ['private', ownerId]]) {
      const expected = { kind: 'status', isOwner: sender === ownerId, ...(taskId ? { taskId } : {}), ...(topic ? { topic } : {}) };
      assert.deepEqual(parse(query, { kind, sender }), expected, query);
    }
  }
});

test('普通任务正文只给 manager 一个补充候选，编号不会降级成无编号', () => {
  for (const value of ['做一个 FPS', '保存文件', '帮我写一个小游戏', '用 Python 写个脚本', 'Build a calculator']) {
    assert.deepEqual(parse(value), supply(value), value);
  }
  for (const value of ['新建编程任务', '创建一个开发任务', '创建一个新的 DSH 任务']) assert.notEqual(parse(value)?.kind, 'new', value);
  assert.deepEqual(parse('任务：离线网页计算器'), supply('离线网页计算器'));
  assert.deepEqual(parse('补充任务 #ABCDef12：做个网页'), { ...supply('做个网页'), taskId: 'abcdef12' });
  for (const id of ['1234', 'xx1234ab', 'abcdef123', '1234abcd0', '1234abcdZZ', '1234 abcd', 'abc-def1', '1234abcd #abcdef12']) {
    for (const value of [`任务 #${id}：做个游戏`, `任务 #${id} 进度`, `重试交付 #${id}`]) assert.equal(parse(value), null, value);
  }
});

test('交付重试仅接受主人带合法编号的独立指令', () => {
  for (const value of ['重试交付 #ABCDef12', '重新上传任务 #abcdef12', '请你重试交付abcdef12！']) {
    assert.deepEqual(parse(value), { kind: 'retry', taskId: 'abcdef12', isOwner: true }, value);
  }
  for (const value of ['重试交付', '重试交付 #abcdef12 吗', '不要重试交付 #abcdef12', '重新上传任务 #abcdef12 给小明', '重试交付 #abcdef12 #1234abcd']) assert.equal(parse(value), null, value);
});

test('闲聊、条件、举例、问法、拒绝和对别人说话不能领取任务', () => {
  for (const value of [
    '晚上好', '明天再说', '天气怎么样', '哈哈', '好的', '做个好梦！', '谢谢你', '别开新会话', '能不能新建一个会话',
    '你可以开一个新的 DSH 会话吗？', '如果可以就开个新会话', '小明，开个新会话，做一个 FPS', '请转告小明开个新会话',
    '举例：新建会话：做一个 FPS', '她说“开个新会话”', '“开个新会话”', '请不要新建会话', '新建一个会话需要多久？',
    '新建会话：请不要执行', '开新会话：如果有空做个游戏', '开新会话，做个游戏，这只是个例子', '新建会话：做个网页吗',
    '开新会话是什么意思', '开新会话，看看电影', '任务：', '任务 #abcdef12：请你先别做', '任务 #abcdef12：晚安',
    '在这个会话中做一个 FPS', '到已有会话继续做个 FPS', '请用已有会话做个网页', '在新的 DSH 会话中',
    '新建会话：小明，做一个 FPS', '开新会话：让小明帮我做个游戏', '开新会话：能不能写个游戏', '开新会话：任务 #123：做个游戏',
    '开新会话：小明说要做个网页', '开新会话：他说“写个游戏”', '任务：她问过怎么做个工具', '开新会话：我不想开会话', '任务：我只是想问问',
    '开新会话，做一个小游戏，先别执行', '开新会话：做一个网站需要多少钱', '任务是不是新建会话', '任务：今天的天气不错',
    '在新会话中＋如果有空做个游戏', '在新会话中+她说要做游戏', '在新会话里＋晚安',
    '你今天过得怎么样了', '那个电影好看吗', '明天的天气怎么样',
    '写个作业', '做一个梦', '做一个好人', '保存体力', '做个游戏吗', '同事问任务进度', '这个群的人说“任务进度呢？”', '电影进度怎么样', '别查进度', '查询其他群的任务进度',
  ]) assert.equal(parse(value), null, value);
});

test('拒绝伪造身份、路由和自发消息；同一秒无法证明先后时丢弃', () => {
  const value = '开个新会话';
  for (const patch of [
    { post_type: 'message_sent' }, { post_type: 'notice' }, { message_type: 'private' }, { self_id: '1' }, { self_id: [] },
    { user_id: selfId }, { sender: { user_id: memberId } }, { user_id: [ownerId] }, { group_id: '457' }, { group_id: '' },
    { history: true }, { replayed: true }, { isSelf: true }, { anonymous: {} }, { sub_type: 'anonymous' },
    { message_id: 0 }, { message_id: null }, { message_id: 1.5 }, { message_id: Number.MAX_SAFE_INTEGER + 1 },
    { time: now / 1000 - 301 }, { time: now / 1000 + 6 }, { time: NaN }, { time: null }, { time: 1.5 }, { time: [now / 1000] },
  ]) assert.equal(parse(value, { event: patch }), null, JSON.stringify(patch));
  for (const patch of [{ now: undefined }, { startedAt: NaN }, { ownerId: '' }, { selfId: null }, { id: groupId + '0' }, { id: [groupId] }]) assert.equal(parse(value, patch), null, JSON.stringify(patch));
  assert.equal(parse(value, { kind: 'private', id: memberId }), null);
  assert.equal(parse(value, { kind: 'private', event: { group_id: groupId } }), null);
  assert.equal(parse(value, { kind: 'private', event: { target_id: memberId } }), null);
  assert.equal(parse(value, { startedAt: now + 1, now: now + 500 }), null);
  assert.deepEqual(parse(value, { startedAt: now + 1, now: now + 1000, event: { time: now / 1000 + 1, message_id: '-987' } }), creation());
  assert.deepEqual(parse(value, { event: { message_id: null, msg_id: -43, time: String(now / 1000) } }), creation());
  assert.equal(parseCodingRequest(), null);
});

test('只使用当前外层的真实 text/at，拒绝多接收方、引用转发和伪造文本', () => {
  for (const value of ['开新会话', '写个游戏', '进度怎么样', '重试交付 #1234abcd']) {
    for (const segments of [
      [at(memberId), text(value)], [at(selfId), text(value), at(memberId)], [at('all'), text(value)], [at(null), text(value)],
      [text(value), { type: 'reply', data: { id: 81 } }], [at(selfId), { type: 'forward', data: { id: 4 } }, text(value)],
      [{ type: 'node', data: { user_id: ownerId, content: [text(value)] } }], [{ type: 'json', data: { data: value } }],
      [text(value + ' [CQ:at,qq=321]')], [text(value + ' <reply id="1">')], [text(value + ' @小明')], [text(value + ' [转发消息 id=1]')],
      [text('@机器人 ' + value)], [text(value + ' ＠某人')], [text(value), text(123)],
    ]) assert.equal(parse(segments), null, JSON.stringify(segments));
  }
  assert.equal(parse('', { event: { message: '开新会话', raw_message: '开新会话' } }), null);
  assert.equal(parse('晚安', { event: { raw_message: '开新会话' } }), null);
  assert.equal(parse(Array.from({ length: 101 }, () => text(''))), null);
  assert.equal(parse('新建会话：' + 'a'.repeat(8000)), null);
});
