// Register consistently across restarts; live bridge policy is authoritative.
// No arbitrary files, URLs, model overrides or external MCP jobs cross this API.
export function registerGeneratedImageTools({ server, z, agentApi }) {
  const common = {
    key: z.string().regex(/^(group|private):[1-9]\d*$/).describe('当前会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('当前会话令牌（见唤醒提示）'),
  };
  const imageId = z.string().min(1).max(80).describe('qq_generate_image 返回的图片编号；只能用于生成时的同一个会话');
  const invoke = (route, timeoutMs) => async ({ token, ...body }) => {
    try {
      const data = await agentApi(`/api/socialV2/${route}`, {
        method: 'POST', headers: { 'x-agent-token': token }, body: JSON.stringify(body), timeoutMs,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }], ...(data.ok === false ? { isError: true } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false,
        code: error?.code || 'IMAGE_BRIDGE_UNAVAILABLE', error: error?.message || '图片工具暂不可用。',
        hint: error?.hint || '请检查 QQ 桥接状态；若已拿到 imageId，查询原编号，不要重复生成。',
      }) }] };
    }
  };
  server.tool('qq_generate_image',
    '为当前 QQ 会话生成一张新图。只提交画面描述和尺寸；后台使用管理员配置的 Magpie 图片模型，受总闸、会话白名单、每日额度与冷却约束。返回 imageId 和 pending/ready 状态。pending 时用 qq_image_result 查询同一编号，不要重新调用生成。生成完成后还须 qq_send_image 才能发到 QQ；生成失败要如实说明。不能传文件路径、网址、参考图或模型。仅在对方要求画图或明确同意时调用。',
    { ...common, prompt: z.string().min(1).max(2000).describe('详细描述画面内容、风格和要出现的文字，不含私密信息'),
      size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional().describe('图片尺寸，默认 1024x1024') },
    invoke('generate-image', 30000));
  server.tool('qq_image_result',
    '查询本会话已有生图任务，最多等约 20 秒。pending 时继续查原 imageId，不重新生成；ready 才可用 qq_send_image。失败带 code/hint，告知对方并按提示处理。',
    { ...common, imageId }, invoke('image-result', 30000));
  server.tool('qq_send_image',
    '把本会话 qq_generate_image 产生且已 ready 的新图发送到当前 QQ 会话。只接受图片编号，不接受本地路径或网址。发送受当前令牌、白名单、暂停/静默和发送频率约束。同图成功发送后重复调用会返回原消息号；发送结果不明时禁止自动重发，请先确认 QQ 是否收到。只有 ok=true 且 sent=1 才能说已发出。',
    { ...common, imageId }, invoke('send-image', 180000));
}
