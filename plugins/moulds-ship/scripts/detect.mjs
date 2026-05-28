#!/usr/bin/env node
/**
 * detect.mjs [--dir <path>]
 * Classifies the directory and prints a JSON descriptor to stdout:
 *   { type: 'mcp'|'manifest'|'script'|'mcp-python'|'idea', ... }
 * Used by the moulds-ship skill to decide the publish path + show the user a plan.
 */
import { detectSource } from './lib.mjs';

const argv = process.argv;
const di = argv.indexOf('--dir');
const dir = di >= 0 && argv[di + 1] ? argv[di + 1] : process.cwd();

try {
  const result = detectSource(dir);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ type: 'error', error: String((e && e.message) || e) }) + '\n');
  process.exit(1);
}
