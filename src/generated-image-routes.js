import { createHash } from 'node:crypto';
import { createGeneratedImageService } from './generated-images.js';

export function imageRouteError(code, error, hint, statusCode = 403) {
  return Object.assign(new Error(error), { code, hint, statusCode });
}

// These dependencies bind the independent file/job service to the existing QQ
// session policy, send queue, rate budgets and conversation bookkeeping.
export function createGeneratedImageRoutes({ root, getConfig, generate, authorize, enqueue, reserveSend, transport, recordReply }) {
  let service;
  const inFlight = new Map();
  const store = () => (service ??= createGeneratedImageService({ root, getConfig, generate }));
  const routes = {
    '/api/socialV2/generate-image': 'generateImage',
    '/api/socialV2/image-result': 'imageResult',
    '/api/socialV2/send-image': 'sendImage',
  };

  async function send(input, assertAllowed) {
    const status = await store().result(input, { assertAllowed });
    if (status.status !== 'ready') {
      if (status.status === 'failed') return status;
      throw imageRouteError('IMAGE_NOT_READY', '图片还在生成，暂时不能发送。', '请用 qq_image_result 查询同一个 imageId，不要重复生成。', 409);
    }
    if (status.sent?.messageId) return { ok: true, imageId: input.imageId, sent: 1, alreadySent: true, messageId: status.sent.messageId };
    if (status.delivery?.status === 'sending' || status.delivery?.status === 'unknown') {
      throw imageRouteError('IMAGE_DELIVERY_UNKNOWN', '这张图已经尝试发送，结果尚未确认。', '请查看 QQ 会话确认是否收到；为避免重复发送，本次不会自动重发。', 409);
    }
    return enqueue(async () => {
      assertAllowed();
      const { buffer } = await store().readReady(input);
      assertAllowed();
      const rollback = reserveSend(input.key);
      let claimed;
      try { claimed = await store().recordSending(input); }
      catch (error) { rollback(); throw error; }
      if (!claimed.claimed) {
        rollback();
        throw imageRouteError('IMAGE_DELIVERY_UNKNOWN', '这张图已经在发送或已发送。', '请查询同一个 imageId；不要重新生成或重复发送。', 409);
      }
      try {
        // Recheck after durable reservation. If permission changed here, keep an
        // uncertain delivery record rather than silently replaying it later.
        assertAllowed();
        const messageId = await transport(input.key, buffer);
        if (!/^-?[1-9]\d*$/.test(String(messageId ?? ''))) throw new Error('Missing message ID');
        await store().recordSent(input, String(messageId));
        recordReply(input.key, input.imageId, String(messageId));
        return { ok: true, imageId: input.imageId, sent: 1, messageId: String(messageId) };
      } catch {
        await store().recordSendFailed(input).catch(() => {});
        throw imageRouteError('IMAGE_DELIVERY_UNKNOWN', '新图发送未取得完整确认。', '请先查看 QQ 会话是否收到，检查网关连接；本次不会自动重发。', 502);
      }
    });
  }

  return {
    matches(url) { return Object.hasOwn(routes, url.pathname); },
    async handle(req, url, { readBody, sendJson }) {
      const action = routes[url.pathname];
      if (!action) return false;
      if (req.method !== 'POST') {
        sendJson({ ok: false, code: 'IMAGE_METHOD', error: '图片接口只接受 POST。', hint: '请使用对应的 QQ 图片工具。' }, 405);
        return true;
      }
      try {
        const body = await readBody();
        const keyMatch = /^(group|private):([1-9]\d*)$/.exec(String(body.key ?? '').trim());
        if (!keyMatch) throw imageRouteError('IMAGE_INVALID_REQUEST', '会话 key 格式不正确。', '请使用当前会话的 group:群号 或 private:QQ号。', 400);
        const key = `${keyMatch[1]}:${keyMatch[2]}`;
        const token = String(req.headers['x-agent-token'] ?? '');
        const assertAllowed = authorize(key, token, action, body);
        assertAllowed();
        const allowed = action === 'generateImage' ? ['key', 'prompt', 'size'] : ['key', 'imageId'];
        if (Object.keys(body).some((k) => !allowed.includes(k))) {
          throw imageRouteError('IMAGE_INVALID_REQUEST', '图片请求包含不支持的字段。', '生图只需 prompt/size；查询与发送只需返回的 imageId，不能传路径、网址或模型。', 400);
        }
        const input = { key, token, ...(action === 'generateImage' ? { prompt: body.prompt, size: body.size } : { imageId: body.imageId }) };
        let data;
        if (action === 'generateImage') data = await store().start(input, { assertAllowed });
        else if (action === 'imageResult') data = await store().result(input, { waitMs: 20000, assertAllowed });
        else {
          const id = `${key}:${createHash('sha256').update(token).digest('hex')}:${input.imageId}`;
          if (!inFlight.has(id)) {
            const pending = send(input, assertAllowed);
            inFlight.set(id, pending);
            void pending.finally(() => inFlight.delete(id)).catch(() => {});
          }
          data = await inFlight.get(id);
        }
        // Every waiter must retain its own current permission after an async job.
        assertAllowed();
        sendJson(data, data?.ok === false ? (data.statusCode || 502) : 200);
      } catch (error) {
        const known = /^IMAGE_[A-Z_]+$/.test(String(error?.code ?? ''));
        sendJson({ ok: false, code: known ? error.code : 'IMAGE_REQUEST_FAILED',
          error: known ? error.message : '图片请求未完成。',
          hint: known && error.hint ? error.hint : '请检查图片设置和服务状态，再查询原 imageId；不要反复重新生成。' },
        known ? error.statusCode || 400 : 500);
      }
      return true;
    },
    async close() { await service?.close?.(); },
  };
}
