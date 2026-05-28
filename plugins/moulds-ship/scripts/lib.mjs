/**
 * moulds-ship shared library — zero npm dependencies (Node 18+ built-ins only).
 * Shells out to `npx esbuild` (bundling) and `zip` (packaging) when needed.
 *
 * Responsibilities: base/credentials config, HTTP + device-auth, source
 * detection, MCP introspection, V2 manifest generation, Tier-2 bundling, and
 * the platform publish calls.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

export const DEFAULT_BASE = 'https://app.moulds.ai';

// ---------------------------------------------------------------------------
// Config + credentials
// ---------------------------------------------------------------------------

export function resolveBase(argv = process.argv) {
  const i = argv.indexOf('--base');
  if (i >= 0 && argv[i + 1]) return argv[i + 1].replace(/\/$/, '');
  if (process.env.MOULDS_BASE_URL) return process.env.MOULDS_BASE_URL.replace(/\/$/, '');
  return DEFAULT_BASE;
}

function credsPath() {
  return join(homedir(), '.moulds', 'credentials.json');
}

function loadCreds() {
  try {
    return JSON.parse(readFileSync(credsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveCreds(creds) {
  const dir = join(homedir(), '.moulds');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(credsPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function getToken(base) {
  const c = loadCreds();
  return c[base]?.access_token ?? null;
}

export function setToken(base, access_token, name) {
  const c = loadCreds();
  c[base] = { access_token, name, saved_at: new Date().toISOString() };
  saveCreds(c);
}

export function clearToken(base) {
  const c = loadCreds();
  delete c[base];
  saveCreds(c);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export async function api(base, path, opts = {}) {
  const { method = 'GET', token, json, form } = opts;
  const headers = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  let body;
  if (form) {
    body = form; // FormData — fetch sets the multipart boundary itself
  } else if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

// ---------------------------------------------------------------------------
// Device-authorization login (RFC 8628)
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawnSync(cmd, [url], { stdio: 'ignore', shell: process.platform === 'win32' });
  } catch {
    /* best-effort */
  }
}

export async function deviceLogin(base, { name } = {}) {
  const start = await api(base, '/api/v1/auth/cli/device-code', { method: 'POST', json: {} });
  if (!start.ok) {
    throw new Error(`device-code request failed (${start.status}): ${JSON.stringify(start.data)}`);
  }
  const { device_code, user_code, verification_uri_complete, verification_uri, interval, expires_in } =
    start.data;

  process.stderr.write(
    `\n  To authorize moulds-ship, open:\n\n    ${verification_uri_complete || verification_uri}\n\n` +
      `  and confirm the code:  ${user_code}\n\n  Waiting for approval…\n`,
  );
  openBrowser(verification_uri_complete || verification_uri);

  const deadline = Date.now() + (expires_in || 600) * 1000;
  const pollMs = Math.max(2, interval || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const poll = await api(base, '/api/v1/auth/cli/token', {
      method: 'POST',
      json: { device_code, name: name || `Claude Code (${hostnameSafe()})` },
    });
    if (poll.ok && poll.data.access_token) {
      setToken(base, poll.data.access_token, poll.data.name);
      process.stderr.write('  ✓ Authorized.\n\n');
      return poll.data.access_token;
    }
    const err = poll.data?.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    throw new Error(`authorization failed: ${err || JSON.stringify(poll.data)}`);
  }
  throw new Error('authorization timed out — re-run to try again');
}

function hostnameSafe() {
  try {
    return spawnSync('hostname', [], { encoding: 'utf-8' }).stdout.trim() || 'cli';
  } catch {
    return 'cli';
  }
}

export async function ensureAuth(base, { name } = {}) {
  const existing = getToken(base);
  if (existing) return existing;
  return deviceLogin(base, { name });
}

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

const MCP_SDK = '@modelcontextprotocol/sdk';

export function detectSource(dir = process.cwd()) {
  const d = resolve(dir);
  const pkgPath = join(d, 'package.json');
  let pkg = null;
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      /* ignore malformed */
    }
  }

  // 1) Existing moulds manifest → passthrough
  for (const f of ['manifest.json', 'moulds.json', 'manifest.yaml', 'moulds.yaml']) {
    const p = join(d, f);
    if (existsSync(p)) {
      const isYaml = f.endsWith('.yaml');
      let version = null;
      if (!isYaml) {
        try {
          version = JSON.parse(readFileSync(p, 'utf-8')).manifest_version ?? null;
        } catch {
          /* ignore */
        }
      }
      return { type: 'manifest', dir: d, path: p, format: isYaml ? 'yaml' : 'json', version };
    }
  }

  // 2) MCP server (Node)
  const allDeps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const hasMcpSdk = Object.keys(allDeps).some((k) => k === MCP_SDK || k.startsWith('@modelcontextprotocol/'));
  const entry = pkg ? resolveEntry(d, pkg) : findLooseEntry(d);
  if (hasMcpSdk && entry) {
    return {
      type: 'mcp',
      runtime: 'node',
      dir: d,
      entry,
      name: pkg?.name || basename(d),
      description: pkg?.description || '',
    };
  }
  // MCP source heuristic: a JS/TS entry that imports the SDK even if not in deps.
  if (entry && fileImportsMcp(entry)) {
    return { type: 'mcp', runtime: 'node', dir: d, entry, name: pkg?.name || basename(d), description: pkg?.description || '' };
  }

  // 3) Python MCP — detected but unsupported in V1 (sandbox is node-only)
  if (existsSync(join(d, 'pyproject.toml')) || existsSync(join(d, 'requirements.txt'))) {
    const py = readSafe(join(d, 'pyproject.toml')) + readSafe(join(d, 'requirements.txt'));
    if (/\bmcp\b|fastmcp/i.test(py)) {
      return { type: 'mcp-python', dir: d, name: basename(d), note: 'Python MCP not supported in V1 (sandbox runtime is node20).' };
    }
  }

  // 4) Plain script
  if (entry) {
    return { type: 'script', dir: d, entry, name: pkg?.name || basename(d), description: pkg?.description || '' };
  }

  // 5) Nothing actionable → idea (AI-draft)
  return { type: 'idea', dir: d, name: basename(d) };
}

function resolveEntry(d, pkg) {
  const candidates = [];
  if (pkg.bin) {
    candidates.push(typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0]);
  }
  if (pkg.module) candidates.push(pkg.module);
  if (pkg.main) candidates.push(pkg.main);
  candidates.push('src/index.ts', 'src/server.ts', 'src/index.mjs', 'src/index.js', 'index.ts', 'index.mjs', 'index.js', 'server.js', 'server.mjs');
  for (const c of candidates) {
    if (c && existsSync(join(d, c))) return join(d, c);
  }
  return null;
}

function findLooseEntry(d) {
  const files = readdirSync(d).filter((f) => /\.(ts|mjs|js)$/.test(f));
  for (const pref of ['index', 'server', 'main']) {
    const hit = files.find((f) => f.startsWith(pref));
    if (hit) return join(d, hit);
  }
  return files.length === 1 ? join(d, files[0]) : null;
}

function fileImportsMcp(entryPath) {
  return /@modelcontextprotocol\//.test(readSafe(entryPath));
}

function readSafe(p) {
  try {
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// MCP introspection (spawn the bundled server, JSON-RPC over stdio)
// ---------------------------------------------------------------------------

export async function introspectMcp(serverPath, { timeoutMs = 20000 } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let settled = false;
    let stderr = '';
    const timer = setTimeout(() => finish(null, new Error('MCP introspection timed out')), timeoutMs);
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');

    function finish(tools, err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      if (err) rej(new Error(`${err.message}${stderr ? `\n--- server stderr ---\n${stderr.slice(0, 800)}` : ''}`));
      else res(tools);
    }

    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) finish(null, new Error(msg.error.message || 'tools/list error'));
          else finish(msg.result?.tools || []);
        }
      }
    });
    child.on('error', (e) => finish(null, e));
    child.on('exit', (code) => {
      if (!settled) finish(null, new Error(`server exited (${code}) before responding`));
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'moulds-ship', version: '0.1.0' } },
    });
  });
}

// ---------------------------------------------------------------------------
// Manifest generation + bundling
// ---------------------------------------------------------------------------

export function slugify(s) {
  return String(s || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^([0-9])/, 'a$1')
    .slice(0, 48) || 'agent';
}

function toolExportName(toolName) {
  return 'tool_' + String(toolName).replace(/[^a-zA-Z0-9_]/g, '_');
}

export function generateV2Manifest({ name, description, slug, tools }) {
  const routes = tools.map((t) => ({
    method: 'POST',
    path: `/api/${slugify(t.name)}`,
    handler: `dist/handler.mjs#${toolExportName(t.name)}`,
  }));
  const toolList = tools.map((t) => `\`${t.name}\`${t.description ? ` — ${t.description}` : ''}`).join('\n- ');
  return {
    manifest_version: 2,
    slug,
    name: name || slug,
    shape: 'app',
    category: 'automation',
    runtime: 'node20',
    package: { entry: 'dist/' },
    ui: { routes },
    integrations: [],
    landing: {
      tagline: (description || `${name} as an API`).slice(0, 140),
      description:
        `${description || name}\n\nExposes ${tools.length} tool endpoint(s):\n- ${toolList}\n\n` +
        `Converted from an MCP server by moulds-ship.`,
    },
    pricing: { free_trial: { quantity: 50, period_days: 30 }, plans: [] },
    platform_fee_pct: 15,
  };
}

/** The Tier-2 handler bundled into the zip: spawns the MCP server per request. */
export function adapterSource(tools) {
  const exports = tools
    .map((t) => `export const ${toolExportName(t.name)} = (req) => handle(${JSON.stringify(t.name)}, req);`)
    .join('\n');
  return `// Auto-generated by moulds-ship. Spawns the bundled MCP server per request
// (stdio JSON-RPC) and forwards the request body as the tool's arguments.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
const CALL_TIMEOUT_MS = 45000;

function callTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => done(null, new Error('MCP tool call timed out')), CALL_TIMEOUT_MS);
    const send = (m) => { try { child.stdin.write(JSON.stringify(m) + '\\n'); } catch {} };
    function done(result, err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      err ? reject(err) : resolve(result);
    }
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args || {} } });
        } else if (msg.id === 2) {
          if (msg.error) done(null, new Error(msg.error.message || 'MCP tool error'));
          else done(msg.result);
        }
      }
    });
    child.on('error', (e) => done(null, e));
    child.on('exit', (code) => { if (!settled) done(null, new Error('MCP server exited (' + code + ') before responding')); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'moulds', version: '0.1.0' } } });
  });
}

async function handle(toolName, req) {
  let args = {};
  try { args = (await req.json()) || {}; } catch {}
  try {
    const result = await callTool(toolName, args);
    return { json: { ok: true, tool: toolName, result } };
  } catch (e) {
    return { json: { ok: false, tool: toolName, error: String((e && e.message) || e) }, status: 502 };
  }
}

${exports}
`;
}

/**
 * Full MCP→Tier-2 pipeline: esbuild the server to a single file, introspect its
 * tools over stdio, generate the V2 manifest + per-tool handler, and zip the
 * bundle. Returns { manifest, zipPath, tools, workDir }.
 */
export async function buildMcpAgent({ entry, name, description, slug }) {
  const workDir = freshWorkDir(slug);
  const dist = join(workDir, 'dist');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  // 1) Bundle the MCP server to a single runnable file.
  const serverOut = join(dist, 'mcp-server.mjs');
  const esb = spawnSync(
    'npx',
    ['-y', 'esbuild', entry, '--bundle', '--platform=node', '--format=esm', '--target=node20', `--outfile=${serverOut}`],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Pin npm/npx cache to a temp dir so a relative `cache=` in the user's
      // ~/.npmrc can't pollute their project directory with a .npm-cache/.
      env: { ...process.env, npm_config_cache: join(tmpdir(), 'moulds-ship-npx-cache') },
    },
  );
  if (esb.status !== 0) {
    throw new Error(`esbuild failed:\n${esb.stderr || esb.stdout}`);
  }

  // 2) Introspect the bundled server for its tool list.
  const tools = await introspectMcp(serverOut);
  if (!tools || tools.length === 0) {
    throw new Error('the MCP server exposed no tools (tools/list was empty) — nothing to publish');
  }

  // 3) Generate the manifest + the per-tool handler adapter.
  const manifest = generateV2Manifest({ name, description, slug, tools });
  writeFileSync(join(dist, 'handler.mjs'), adapterSource(tools));

  // 4) Zip the bundle (dist/ at the zip root).
  const outZip = join(workDir, `${slug}.zip`);
  const zip = spawnSync('zip', ['-r', '-q', outZip, 'dist'], { cwd: workDir, encoding: 'utf-8' });
  if (zip.status !== 0) {
    throw new Error(`zip failed (is the 'zip' CLI installed?):\n${zip.stderr || zip.stdout}`);
  }
  return { manifest, zipPath: outZip, tools, workDir };
}

export function freshWorkDir(slug) {
  return join(tmpdir(), `moulds-ship-${slug}-${Date.now()}`);
}

// ---------------------------------------------------------------------------
// Publish calls
// ---------------------------------------------------------------------------

export async function createApp(base, token, manifestJson) {
  return api(base, '/api/v1/dashboard/apps', { method: 'POST', token, json: { manifest_json: manifestJson } });
}

export async function uploadPackage(base, token, { manifestJson, zipPath }) {
  const bytes = readFileSync(zipPath);
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifestJson));
  form.append('package', new Blob([bytes], { type: 'application/zip' }), basename(zipPath));
  return api(base, '/api/v1/agent-packages', { method: 'POST', token, form });
}

export async function activatePackage(base, token, packageId) {
  return api(base, `/api/v1/agent-packages/${packageId}/activate`, { method: 'POST', token });
}

export async function submitForReview(base, token, slug) {
  return api(base, `/api/v1/dashboard/apps/${slug}/submit-for-review`, { method: 'POST', token });
}
