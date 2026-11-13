// Compatibility entry: authenticated shared reader, including orig and Opus.
import { runReadDynamic } from '../lib/read-dynamic-command.mjs';
process.exitCode = await runReadDynamic();
