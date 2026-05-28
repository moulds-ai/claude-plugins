#!/usr/bin/env node
/**
 * login.mjs [--base <url>] [--force]
 * Ensures a moulds.ai CLI token exists for the target base, running the
 * device-authorization flow if needed (prints the code + URL to stderr and
 * waits for browser approval). Idempotent unless --force.
 */
import { resolveBase, getToken, clearToken, deviceLogin } from './lib.mjs';

const base = resolveBase();
const force = process.argv.includes('--force');

try {
  if (force) clearToken(base);
  const existing = getToken(base);
  if (existing && !force) {
    process.stdout.write(JSON.stringify({ ok: true, base, status: 'already-authorized' }) + '\n');
    process.exit(0);
  }
  await deviceLogin(base, {});
  process.stdout.write(JSON.stringify({ ok: true, base, status: 'authorized' }) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, base, error: String((e && e.message) || e) }) + '\n');
  process.exit(1);
}
