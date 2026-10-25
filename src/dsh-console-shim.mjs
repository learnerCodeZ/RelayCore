// Preloaded via `--import` into the DSH ACP subprocess. The ACP JSON-RPC
// transport requires every stdout line to be one protocol frame, but bundled
// DSH plugins (e.g. dsh-llm-deepseek-account) log through console.info, which
// Node writes to stdout. Redirect those console methods to stderr so plugin
// logging cannot corrupt the protocol channel. console.error and console.warn
// already write to stderr and are left untouched.
import { format } from 'node:util';

const redirect = (...args) => { process.stderr.write(`${format(...args)}\n`); };
for (const method of ['log', 'info', 'debug', 'dir']) console[method] = redirect;
