// Read only: outer dynamic + forwarded original, including modern Opus text.
import { runReadDynamic } from '../lib/read-dynamic-command.mjs';
process.exitCode = await runReadDynamic();
