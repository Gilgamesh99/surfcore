const MAX_AGE_MS = 5 * 60_000;
const MAX_TEXT_LENGTH = 8_000;
const POSITIVE_ID = /^[1-9]\d{0,19}$/u;
const MESSAGE_ID = /^-?[1-9]\d{0,19}$/u;

function idString(value, pattern = POSITIVE_ID) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return '';
  const id = String(value);
  return pattern.test(id) ? id : '';
}

// Read only the original OneBot text and at segments. Display names, raw_message
// and the contents of replies/forwarded nodes cannot address or authorize a task.
function directText(message, self) {
  if (!Array.isArray(message) || message.length > 100) return '';
  let text = '';
  let addressed = false;
  for (const segment of message) {
    if (segment?.type === 'at' && idString(segment.data?.qq) === self) {
      if (!text.trim()) addressed = true;
      text += ' ';
    } else if (segment?.type === 'text' && typeof segment.data?.text === 'string') text += segment.data.text;
    else return '';
    if (text.length > MAX_TEXT_LENGTH) return '';
  }
  if (/(?:\[|&#91;)\s*CQ\s*[:：]|<\s*(?:at|reply|forward|node)\b|\[(?:回复|引用|转发消息|聊天记录)|(?:^|[\s，,:：])[@＠]\S|[@＠](?:\p{Script=Han}|\d{3,})/iu.test(text)) return '';
  return addressed ? text.trim().replace(/^[，,:：]\s*/u, '') : text.trim();
}

const POLITE = /^(?:(?:请|麻烦|劳驾)\s*)?(?:你\s*)?(?:(?:帮我|给我|替我|帮忙)\s*)?/u;
const DSH_LOCATION = /^(?:在|用|去)\s*DSH\s*(?:里面|里|中|上)?\s*/iu;
const CREATE = /^(新建|创建|新开|另开|另建|再开|开设|打开|开启|开)\s*(?:一下\s*)?(?:一?个\s*)?/u;
const SESSION_NAME = /^(?:新的?\s*)?(?:独立的?\s*)?(?:DSH\s*的?\s*(?:新的?\s*)?)?(?:(?:编程|开发)\s*)?(?:会话|对话)/iu;
const IN_NEW_SESSION = /^(?:在|使用|用|通过|到|去)\s*(?:一?个\s*)?(?:DSH\s*的?\s*)?新的?\s*(?:独立的?\s*)?(?:DSH\s*的?\s*)?(?:(?:编程|开发)\s*)?(?:会话|对话)\s*(?:里面|中|内|里|上)?/iu;
const TASK_LABEL = /^(?:(?:补充|编程|开发)\s*)?任务(?:内容|描述|要求)?\s*(?:[#＃]?\s*([0-9a-f]{8})\s*)?(?:是(?!不是)\s*[:：]?|为\s*[:：]?|[:：])\s*(.*)$/isu;
const RETRY = /^(?:重试交付|重新上传)(?:任务)?\s*[#＃]?\s*([0-9a-f]{8})[。！!]?$/iu;

function statusIntent(text, isOwner) {
  // Remove at most one complete reference. A malformed or second ID therefore
  // cannot accidentally turn a specific lookup into a lookup of the latest task.
  const reference = /(?:[#＃]\s*|(?<![0-9a-z_]))([0-9a-f]{8})(?![0-9a-z_])/iu.exec(text);
  const question = (reference ? text.replace(reference[0], '') : text).trim()
    .replace(/[？?！!。]+$/u, '').replace(/^(?:请问(?:一下)?|想问(?:一下|下)?)\s*/u, '').replace(POLITE, '')
    .replace(/^(?:查询|查看|查一?下|查查|查|看一?下|看看|问一?下|汇报(?:一下)?)\s*/u, '');
  let query = question.replace(/\s+/gu, '');
  if (reference) query = query.replace(/^[:：,，]|[:：,，]$/gu, '');
  const subject = /^(?:(?:现在|目前|当前|最新|刚才|上次|这个|那个|本次|这次)的?)*(?:DSH)?(?:编程|开发|代码)?(?:任务|项目)的?/iu;
  const hasTask = subject.test(query);
  query = query.replace(subject, '').replace(/^(?:现在|目前|当前)的?/u, '');
  const progress = /^(?:(?:编程|开发|任务)的?)?(?:进度|进展|状态)(?:如何|怎样|怎么样|咋样|多少|是什么|到哪(?:里|儿|一步)?|有更新吗)?(?:了|啦|呢)?$/u;
  const working = /(?:(?:进行|开发|进展|做|写|弄)(?:到哪(?:里|儿|一步)?|[得的]?(?:怎么样|咋样|如何))了?|(?:做完|做好|写完|完成|结束)了?(?:吗|没(?:有)?))$/u;
  if (progress.test(query) || query.search(working) === 0
      || ((hasTask || reference) && /^(?:情况)?(?:怎么样了?|如何了?|好了吗|还有多久|到哪(?:里|儿|一步)?了?)$/u.test(query))
      || (hasTask && (query === '情况' || (reference && !query)))) {
    return reference ? { kind: 'status', taskId: reference[1].toLowerCase(), isOwner } : { kind: 'status', isOwner };
  }
  // A demonstrative plus a work predicate binds a topic without turning general
  // conversation about a film or the weather into a request for a status update.
  const subjectText = /^(?:(?:刚才|上次|前面)的?\s*)?[这那](?:个|款|份|项|套|张|本|段)\s*(.+)$/u.exec(question)?.[1];
  const ending = subjectText && working.exec(subjectText);
  if (reference || hasTask || !ending?.index) return null;
  const topic = subjectText.slice(0, ending.index).trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} _+.()-]{0,39}$/u.test(topic) ? { kind: 'status', topic, isOwner } : null;
}

// Ambiguous commands stay in chat. A URL can contain its own question mark,
// and a requirement such as “不要使用外部依赖” can follow an affirmative task.
function isDiscussion(text) {
  const prose = text.replace(/https?:\/\/[^\s<>"'“”‘’，。！？；]+/giu, 'URL');
  return /[?？]|(?:吗|么|呢|好不好|行不行|可不可以|是不是|对不对|什么意思|要多久|多久|多少钱|怎么回事|会怎样|怎么样)[。！!]*$/u.test(prose)
    || /^(?:我(?:不想|不打算|没(?:有)?要求|只是(?:想)?(?:问|举例|讨论))|[\p{L}\d_-]{1,12}\s*(?:说|问|转述)(?:过|了|要|想|让|能否|是否|怎么|请|做|写|开|[：“「『"'，,]))/u.test(prose.replace(POLITE, ''))
    || /^(?:(?:你|先|暂时|千万|真的)\s*)*(?:不(?:要|用|必|许|准)|别|勿|禁止|取消|停止|如果|假如|假设|要是|是否|能否|能不能|要不要|可不可以|可以不可以|怎么|如何|想问|请问|问一下|比如|例如|举例|示例|有人说|听说|据说|[“‘「『"'＞>])/u.test(prose.replace(POLITE, ''))
    || /(?:的话(?:[，,\s]|请|需要|要|先|再|才|就|$)|(?:需要什么(?:权限|条件)|要多久)[。！!]*$|(?:^|[，,。；;：:\n])\s*(?:(?:这|上面)(?:句|个)?(?:只)?是(?:个)?(?:例子|示例|举例)|(?:请)?(?:先|暂时)?(?:别|不要|勿)(?:真的?)?(?:执行|新建|开会话)|我只是(?:问问|举例)))/u.test(prose);
}

const CODING_ACTION = /^(?:编写|编程实现|开发|实现|构建|搭建|重构|修复|调试|编译|移植|集成)\s*\S/u;
const GENERAL_ACTION = /^(?:做|写|制作|设计|创建|生成|重写|修改|优化|打包|保存|导出|添加|增加|把|将|给|用|为)\s*\S/u;
const ARTIFACT = /(?:游戏|网页|网站|程序|脚本|项目|文件|代码|页面|工具|软件|应用|组件|函数|界面|计算器|换算器|模拟器|机器人|插件|动画|演示|五子棋|贪吃蛇|\b(?:FPS|HTML|CSS|JSX?|Python|API|app|demo)\b|\.[a-z][a-z0-9]{0,5}\b)/iu;

function taskBody(value, { labeled = false, newSession = false } = {}) {
  const task = value.trim();
  const action = task.replace(POLITE, '');
  if (!task || isDiscussion(task)) return '';
  if (/^(?:(?:今[天晚]|明天|昨天)的?)?(?:天气|心情|晚饭)(?:真|挺|很|不|太|也|还是|怎么|吃什么)/u.test(action)) return '';
  if (/^(?:你好|您好|谢谢你?|晚安|早安|哈哈+|呵呵+|在吗|收到|好的?|没事|算了|明天再说|先聊会|做[个一]*好梦)[呀吧啦啊哦！!。\s]*$/u.test(action)) return '';
  // A vocative or delegation can follow the command delimiter, too.
  if (/^(?:转告|转述给|(?:叫|让)\S{1,10}(?:帮我|帮你|替我|来做|去做))|^(?!需求|要求|目标|说明)[\p{L}\d_-]{1,12}[，,：:]\s*(?:请|麻烦|你|帮我|给我|来|去|做|写|开)/u.test(action)) return '';
  if (/^(?:在|到|用|回到|继续使用)(?:当前|已有|现有|原来|上一个|这[个条])的?\s*(?:DSH\s*)?(?:会话|对话)/iu.test(action)) return '';
  // A deliberate session command or task label can describe any deliverable.
  // Only an unlabeled follow-up in ordinary chat needs evidence of coding work.
  if (labeled || CODING_ACTION.test(action) || (GENERAL_ACTION.test(action) && (newSession || ARTIFACT.test(action)))
      || (newSession && /^(?:加上?|完成|整理|检查|删除|调整|绘制|支持|新增|翻译|替换|测试|从|按|让)\S/u.test(action))
      || /^(?:build|create|implement|write|fix|make|generate)\s+\S/iu.test(action)) return task;
  return '';
}

/** The bridge supplies an authenticated live route and the current connection's
 * start time (milliseconds). Only the manager may consume supply for an already
 * pending task of this owner and origin, or retry a known failed delivery. */
export function parseCodingRequest({ event, kind, id, selfId, ownerId, startedAt, now } = {}) {
  if (!event || event.post_type !== 'message' || event.message_type !== kind || !['private', 'group'].includes(kind)
      || event.history || event.replayed || event.isSelf || event.anonymous || ['anonymous', 'notice'].includes(event.sub_type)) return null;
  const owner = idString(ownerId);
  const self = idString(selfId);
  const sender = idString(event.user_id);
  const peer = idString(id);
  if (!owner || !self || owner === self || !sender || sender === self || !peer || idString(event.self_id) !== self
      || (event.sender?.user_id !== undefined && idString(event.sender.user_id) !== sender)) return null;
  const isOwner = sender === owner;
  if (kind === 'group' ? idString(event.group_id) !== peer
    : !isOwner || peer !== owner || event.group_id != null || (event.target_id != null && idString(event.target_id) !== self)) return null;
  const time = Number(idString(event.time)) * 1000;
  if (!idString(event.message_id ?? event.msg_id, MESSAGE_ID) || !time || !Number.isSafeInteger(time)
      || !Number.isSafeInteger(now) || !Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > now
      || time < startedAt || time > now + 5_000 || now - time > MAX_AGE_MS) return null;

  const text = directText(event.message, self);
  if (!text) return null;
  const status = statusIntent(text, isOwner);
  if (status || !isOwner || isDiscussion(text)) return status;
  const direct = text.replace(POLITE, '');
  const retry = RETRY.exec(direct);
  if (retry) return { kind: 'retry', taskId: retry[1].toLowerCase(), isOwner };
  const located = direct.replace(DSH_LOCATION, '');
  const create = CREATE.exec(located);
  const name = create && SESSION_NAME.exec(located.slice(create[0].length));
  // 开个会话 may refer to an existing session. Only the session name can disambiguate it.
  if (name && ['开', '打开', '开启'].includes(create[1]) && !/新|独立/u.test(name[0])) return null;
  const inSession = IN_NEW_SESSION.exec(direct);
  if (name || inSession) {
    const tail = (name ? located.slice(create[0].length + name[0].length) : direct.slice(inSession[0].length)).trim();
    if (/^(?:吧|一下)?[。！!：:]?$/u.test(tail)) return name ? { kind: 'new', task: '', isOwner } : null;
    const rest = tail.replace(/^[\s，,：:。]+/u, '').replace(/^[+＋]\s*/u, '').replace(/^(?:用来|然后|来|去|并)\s*/u, '');
    const label = TASK_LABEL.exec(rest);
    if (label?.[1] || /^任务\s*[#＃]/u.test(rest)) return null;
    const task = taskBody(label ? label[2] : rest, { labeled: !!label || /^[：:+＋]/u.test(tail), newSession: true });
    return task ? { kind: 'new', task, isOwner } : null;
  }
  const label = TASK_LABEL.exec(direct);
  const task = taskBody(label ? label[2] : text, { labeled: !!label });
  if (!task) return null;
  return label?.[1] ? { kind: 'supply', task, taskId: label[1].toLowerCase(), isOwner } : { kind: 'supply', task, isOwner };
}
