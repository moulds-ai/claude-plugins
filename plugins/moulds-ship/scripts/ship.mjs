#!/usr/bin/env node
/**
 * ship.mjs [--dir <path>] [--base <url>] [--manifest <path>] [--package <zip>] [--name <n>]
 *
 * End-to-end publish of an automation to moulds.ai:
 *   detect (or use --manifest) → ensure auth → (MCP) bundle → create app
 *   → (Tier-2) upload + activate → submit for review → print result.
 *
 * Prints human-readable progress to stderr and a final JSON result to stdout.
 */
import { readFileSync } from 'node:fs';
import {
  resolveBase,
  ensureAuth,
  clearToken,
  detectSource,
  buildMcpAgent,
  slugify,
  createApp,
  uploadPackage,
  activatePackage,
  submitForReview,
} from './lib.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function log(msg) {
  process.stderr.write(msg + '\n');
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
function fail(msg, extra = {}) {
  out({ ok: false, error: msg, ...extra });
  process.exit(1);
}

const base = resolveBase();
const dir = arg('--dir') || process.cwd();
const manifestArg = arg('--manifest');
const packageArg = arg('--package');
const nameArg = arg('--name');

let manifest;
let zipPath = packageArg;
let tools;

try {
  // 1) Resolve manifest + (for Tier-2) the bundle zip.
  if (manifestArg) {
    manifest = JSON.parse(readFileSync(manifestArg, 'utf-8'));
    if (manifest.manifest_version === 2 && !zipPath) {
      fail('a v2 (Tier-2) manifest needs a bundle — pass --package <zip>, or run ship from the MCP source directory to auto-bundle.');
    }
  } else {
    const det = detectSource(dir);
    log(`Detected source type: ${det.type}`);
    if (det.type === 'mcp') {
      const slug = slugify(det.name);
      log(`Bundling MCP server (${det.entry}) → introspecting tools…`);
      const built = await buildMcpAgent({ entry: det.entry, name: nameArg || det.name, description: det.description, slug });
      manifest = built.manifest;
      zipPath = built.zipPath;
      tools = built.tools;
      log(`Found ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`);
    } else if (det.type === 'manifest') {
      if (det.format === 'yaml') {
        fail('found a YAML manifest — convert it to manifest.json first (Claude can do this), then re-run.');
      }
      manifest = JSON.parse(readFileSync(det.path, 'utf-8'));
      if (manifest.manifest_version === 2 && !zipPath) {
        fail('found a v2 manifest but no bundle — run ship from the MCP source dir to auto-bundle, or pass --package <zip>.');
      }
    } else if (det.type === 'mcp-python') {
      fail('Python MCP servers are not supported in V1 (the moulds.ai sandbox runtime is node20). Re-implement as a Node MCP server, or describe the idea so Claude can draft a Tier-1 agent.');
    } else {
      fail(`no MCP server or moulds manifest found (detected: ${det.type}). For a script or an idea, let Claude draft a manifest.json from the description, then re-run with --manifest manifest.json.`);
    }
  }

  if (nameArg) manifest.name = nameArg;
  const slug = manifest.slug || slugify(manifest.name);

  // 2) Auth (device flow if needed).
  let token = await ensureAuth(base, {});

  // 3) Create the app row (retry once on auth failure).
  log(`Creating app "${slug}" on ${base}…`);
  let created = await createApp(base, token, manifest);
  if (created.status === 401) {
    clearToken(base);
    token = await ensureAuth(base, {});
    created = await createApp(base, token, manifest);
  }
  if (created.status === 409 || created.data?.code === 'CONFLICT') {
    fail(`slug "${slug}" is already taken — rename the agent (edit manifest "slug"/"name") and re-run.`, { slug });
  }
  if (created.status === 403 || created.data?.code === 'FORBIDDEN') {
    fail('your account is not a builder yet — visit ' + base + '/me/profile and click "Become a builder", then re-run.');
  }
  if (!created.ok) {
    fail(`create app failed (${created.status}): ${JSON.stringify(created.data)}`, { slug });
  }
  log(`✓ App created (id ${created.data.app_id}).`);

  // 4) Tier-2: upload + activate the bundle.
  if (zipPath) {
    log('Uploading package bundle…');
    const up = await uploadPackage(base, token, { manifestJson: manifest, zipPath });
    if (!up.ok) fail(`package upload failed (${up.status}): ${JSON.stringify(up.data)}`, { slug });
    log(`✓ Package uploaded (${up.data.packageId}). Activating…`);
    const act = await activatePackage(base, token, up.data.packageId);
    if (!act.ok) fail(`activation failed (${act.status}): ${JSON.stringify(act.data)}`, { slug });
    log('✓ Package activated.');
  }

  // 5) Submit for admin review.
  const sub = await submitForReview(base, token, slug);
  if (!sub.ok) fail(`submit-for-review failed (${sub.status}): ${JSON.stringify(sub.data)}`, { slug });
  log('✓ Submitted for review.');

  out({
    ok: true,
    slug,
    tier: zipPath ? 2 : 1,
    tools: tools ? tools.map((t) => t.name) : undefined,
    dashboard_url: `${base}/dashboard/apps/${slug}`,
    public_url_after_approval: `${base}/agents/${slug}`,
    message: 'Shipped! Pending admin approval before it appears publicly in the catalog.',
  });
} catch (e) {
  fail(String((e && e.stack) || (e && e.message) || e));
}
