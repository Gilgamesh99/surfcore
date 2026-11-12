// Host-owned Magpie MCP adapter. QQ supplies only a prompt and one approved size.
// Keep one stdio client alive for generate_image + every generation_result: job IDs
// live in the Magpie process, so reconnecting or retrying generation can lose jobs/cost twice.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function backendError(code, message, hint) {
  return Object.assign(new Error(message), { code, hint, statusCode: 502 });
}

export function magpiePendingId(result) {
  const text = (result?.content ?? []).filter((v) => v.type === 'text').map((v) => v.text).join('\n');
  // Magpie's public contract is text, not structuredContent. Do not parse arbitrary
  // quoted strings/model commentary as job IDs or accept an output path from it.
  return /call generation_result with id ["'](image-\d+-\d+)["']/.exec(text)?.[1] ?? null;
}

export function createMagpieImageGenerator({ getConfig, clientFactory, transportFactory } = {}) {
  return async function generate({ prompt, size, path: output }, { signal, assertAllowed } = {}) {
    const cfg = getConfig?.() ?? {};
    const command = String(cfg.magpieCommand ?? '').trim();
    if (!command || !path.isAbsolute(command) || !fs.statSync(command, { throwIfNoEntry: false })?.isFile()) {
      throw backendError('IMAGE_BACKEND_UNAVAILABLE', '没有配置可用的 Magpie 程序。', '在 SurfCore 的生图设置中填写本机 Magpie 可执行文件绝对路径。');
    }
    const client = clientFactory?.() ?? new Client({ name: 'surfcore-controlled-images', version: '1.0.0' });
    const transport = transportFactory?.({ command, cwd: path.dirname(output) }) ?? new StdioClientTransport({
      command, args: ['mcp', 'image'], cwd: path.dirname(output), stderr: 'ignore',
    });
    const close = () => { void client.close().catch(() => {}); };
    signal?.addEventListener('abort', close, { once: true });
    try {
      signal?.throwIfAborted();
      await client.connect(transport, { timeout: 15000, signal });
      const catalog = await client.listTools(undefined, { timeout: 15000, signal });
      const imageTool = catalog?.tools?.find((tool) => tool.name === 'generate_image');
      if (!imageTool?.inputSchema?.properties?.path || !catalog.tools.some((tool) => tool.name === 'generation_result')) {
        throw backendError('IMAGE_BACKEND_INCOMPATIBLE', '当前 Magpie 图片接口不支持受控文件输出。', '请使用提供 generate_image(path) 与 generation_result 的 Magpie stdio 图片接口。');
      }
      await assertAllowed?.();
      const args = { prompt, size, n: 1, path: output, quality: 'medium' };
      if (cfg.model) args.model = String(cfg.model);
      let response = await client.callTool({ name: 'generate_image', arguments: args }, undefined, { timeout: 45000, signal });
      for (;;) {
        signal?.throwIfAborted();
        if (response?.isError) {
          throw backendError('IMAGE_BACKEND_FAILED', 'Magpie 未完成这次图片生成。', '请在 Magpie 中检查图片模型、登录和额度；不要反复提交相同请求。');
        }
        const id = magpiePendingId(response);
        if (id) {
          response = await client.callTool({ name: 'generation_result', arguments: { id } }, undefined, { timeout: 45000, signal });
          continue;
        }
        // Only inspect the predetermined output. Never read a path/URL returned by
        // the external tool, and let the service validate bytes, symlinks and hash.
        if (fs.existsSync(output)) return;
        // Magpie changes the requested extension to match provider bytes. Only
        // accept the exact host-owned basename with a known raster extension;
        // never trust any path written in model/provider prose.
        const basename = output.slice(0, -path.extname(output).length);
        const alternatives = ['.jpg', '.jpeg', '.webp'].map((ext) => basename + ext)
          .filter((file) => fs.existsSync(file));
        if (alternatives.length === 1) {
          const stat = fs.lstatSync(alternatives[0]);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
            fs.renameSync(alternatives[0], output);
            return;
          }
        }
        throw backendError('IMAGE_OUTPUT_MISSING', '生成工具没有交付可发送的图片。', '请查看 Magpie 图片生成记录；本次不会自动重新生成。');
      }
    } catch (error) {
      if (String(error?.code ?? '').startsWith('IMAGE_')) throw error;
      throw backendError(signal?.aborted ? 'IMAGE_TIMEOUT' : 'IMAGE_BACKEND_UNAVAILABLE',
        signal?.aborted ? '图片生成超时或已取消。' : '无法完成与 Magpie 的连接或调用。',
        '请在 Magpie 检查生成记录和服务状态；未确认结果前不要重新生成。');
    } finally {
      signal?.removeEventListener('abort', close);
      await client.close().catch(() => {});
    }
  };
}
