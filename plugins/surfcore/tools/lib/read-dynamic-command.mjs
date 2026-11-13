import fs from 'node:fs';
import { accountBili } from './state-paths.mjs';
import { makeHeaders } from './msgfeed.mjs';
import { createDynamicReader, dynamicIdFrom, formatDynamicRead } from './dynamic-reader.mjs';

// Common CLI adapter. Returns an exit code; no import-time network or state writes.
export async function runReadDynamic(args = process.argv.slice(2)) {
  const get = (key, fallback) => {
    const index = args.indexOf('--' + key);
    return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
  };
  const input = get('id', args[0]?.startsWith('--') ? '' : args[0]);
  const id = dynamicIdFrom(input);
  const json = args.includes('--json');
  const output = (result) => console.log(json ? JSON.stringify(result, null, 2) : formatDynamicRead(result, { maxChars: Number(get('max-chars', '12000')) }));
  if (!id) {
    output({ ok: false, code: 'dynamic.invalid-id', error: '缺少有效的动态 ID 或 B站动态链接。', hint: '用法：node bili.mjs read-dynamic <动态id或链接> [--json] [--max-chars 12000]；19位 ID 必须原样保留。' });
    return 2;
  }
  // Preserve public inspection when no login has been saved; visibility is decided by B站.
  let headers = makeHeaders({});
  delete headers.cookie;
  try {
    const cred = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'));
    if (!cred?.sessdata || typeof cred.sessdata !== 'string') throw new Error('missing login');
    headers = makeHeaders(cred);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      output({ ok: false, code: 'dynamic.credentials', error: '无法读取 B站登录凭据。', hint: '在 SurfCore 的 B站设置中重新登录，然后重试 read-dynamic。' });
      return 3;
    }
  }
  const result = await createDynamicReader({ headers })(id);
  output(result);
  return result.ok ? 0 : 4;
}
