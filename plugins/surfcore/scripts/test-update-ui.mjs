import assert from 'node:assert/strict';
const noop = () => {};
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useCallback: (fn) => fn, useEffect: noop, useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }), useState: (value) => [typeof value === 'function' ? value() : value, noop],
};
let client;
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { client = factory((name) => name === 'react' ? React : {}); } } };
await import('../lib/client.js');
const { updateSummary, updateItemState, updatePromptSignature, UpdatesModal } = client.__test;
const local = { id: 'surfcore', name: 'SurfCore', channel: 'git', available: true, status: 'latest', ahead: 2, behind: 0, updateAvailable: false, installedVersion: '0.8.9', latestVersion: '0.8.9' };
assert.equal(updateSummary({ results: [local] }).ok, true);
assert.match(updateItemState(local), /保留 2 个本地提交/);
assert.doesNotMatch(updateItemState(local), /undefined/);
assert.equal(updateSummary({}).ok, false);
assert.doesNotMatch(updateSummary({}).text, /已是最新/);
const blocked = { ...local, status: 'blocked', blocked: '本地有未提交改动', hint: '先保存为提交再检查', updateAvailable: true };
const blockedStatus = { results: [blocked], pending: [], pendingCount: 0, availableUpdateCount: 1, blockedUpdateCount: 1 };
assert.equal(updateSummary(blockedStatus).ok, false);
assert.match(updateSummary(blockedStatus).text, /受阻/);
const failed = { ...local, available: false, status: 'failed', reason: '远端连接失败', hint: '检查网络后重试' };
assert.match(updateSummary({ results: [failed], pendingCount: 0 }).text, /检查失败/);
assert.match(updateItemState(failed), /远端连接失败/);
const update = { ...local, status: 'update', updateAvailable: true, remote: 'a'.repeat(40) };
assert.match(updateSummary({ results: [update], pendingCount: 0 }).text, /1 个有更新/);
assert.notEqual(updatePromptSignature([update]), updatePromptSignature([{ ...update, remote: 'b'.repeat(40) }]));
assert.match(updateSummary({ results: [local], lastApply: { status: 'pending_restart' } }).text, /等待退出/);
assert.equal(updateSummary({ results: [{ ...local, versionStale: true }] }).ok, false);
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...tree.children.flatMap(nodes)];
}
function text(tree) {
  if (tree == null) return '';
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  if (typeof tree !== 'object') return String(tree);
  return text(tree.children);
}
const blockedTree = UpdatesModal({ status: blockedStatus, toast: noop });
assert.match(text(blockedTree), /本地有未提交改动/);
assert.match(text(blockedTree), /先保存为提交再检查/);
assert.equal(nodes(blockedTree).find((x) => x.type === 'input').props.disabled, true);
assert.doesNotMatch(text(blockedTree), /zip 覆盖安装/);
const dismissedTree = UpdatesModal({ status: { results: [update], pending: [], pendingCount: 0 }, toast: noop });
assert.equal(nodes(dismissedTree).find((x) => x.type === 'input').props.disabled, false);
assert.equal(nodes(dismissedTree).find((x) => x.type === 'input').props.checked, true);
const queuedTree = UpdatesModal({ status: { results: [update], lastApply: { status: 'pending_restart' } }, toast: noop });
assert.equal(nodes(queuedTree).find((x) => x.type === 'input').props.disabled, true);
console.log('PASS update UI: local commits, blocked/failed/stale states, dismissed updates, pinned prompt identity, modal actions');
