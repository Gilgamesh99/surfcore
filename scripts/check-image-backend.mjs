// Read-only protocol check: never calls generation or delivery tools.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const command = process.argv[2];
if (!command || !path.isAbsolute(command) || !fs.statSync(command, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('Pass the absolute Magpie executable path.');
}
const client = new Client({ name: 'surfcore-image-capability-check', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command, args: ['mcp', 'image'], stderr: 'ignore' }), { timeout: 15000 });
  const { tools } = await client.listTools(undefined, { timeout: 15000 });
  const image = tools.find(tool => tool.name === 'generate_image');
  const properties = image?.inputSchema?.properties ?? {};
  const report = { compatible: !!properties.path && tools.some(tool => tool.name === 'generation_result'),
    generateImage: !!image, outputPath: !!properties.path, singleImage: !!properties.n,
    resultPolling: tools.some(tool => tool.name === 'generation_result'), models: properties.model?.enum ?? null };
  console.log(JSON.stringify(report, null, 2));
  if (!report.compatible) process.exitCode = 1;
} finally { await client.close().catch(() => {}); }
