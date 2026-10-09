/**
 * WorkflowAgent E2E — krea2_location_sheet
 *
 * Two anchor modes, both rendered on a real GPU:
 *   A. prompt mode     — no reference_image: KREA-2 generates the anchor from prompt_location
 *                        (a draft-like profile with video width/height/fps overrides is applied
 *                        and must NOT change the sheet: anchor_width/anchor_height are named so
 *                        profiles cannot reach them and fps is not a port at all).
 *   B. reference mode  — reference_image supplied, no prompt: the image IS the anchor (the KREA-2
 *                        stage is skipped); anchor_preview must have the fixture's pixel size.
 * Plus manifest checks (reference_image optional; no fps / width / height params).
 *
 * Cost: REAL GPU + S3 (the reference fixture is staged in S3). The script tears the endpoint down
 * in `finally`; still verify no orphaned provider resources afterwards (root CLAUDE.md
 * "cloud resources"). Needs S3_BUCKET / AWS_ACCESS_KEY / AWS_SECRET_KEY (+ AWS_REGION).
 *
 * Run inside the harness container (standard fat-image deployment; `/tmp/deploy-app.env` holds the
 * deployed golem env name, single quotes keep `$(cat ...)` inside the container):
 *   docker exec -it harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/krea2_location_sheet/e2e-test.ts --yes'
 *
 * Dev-tree fallback (local golem server, not via fat image; fork golem binary):
 *   cd video-harness && source .env && export WORK_DIR="$(cd .. && pwd)" && \
 *     golem -L repl --script-file ../workflows/krea2_location_sheet/e2e-test.ts --yes
 */

// ── CONFIG ────────────────────────────────────────────────────────────────────
const WF_NAME              = "krea2_location_sheet";
const GPU_TYPE             = "l40s";           // 48 GB VRAM — H3 32B CLIP requires 48 GB minimum
const TIMEOUT_SEC          = 5400;
const PROVISION_TIMEOUT_MS = 5400000;          // 90 min — ~60 GB model download
const RENDER_TIMEOUT_MS    = 3600000;          // 60 min per render — KREA-2 + H3 pipeline
const RENDER_POLL_MS       = 30_000;

const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND ?? 'modal';
const S3_BUCKET       = process.env.S3_BUCKET       ?? '';
const AWS_REGION      = process.env.AWS_REGION      ?? 'us-east-1';
const AWS_ACCESS_KEY  = process.env.AWS_ACCESS_KEY  ?? '';
const AWS_SECRET_KEY  = process.env.AWS_SECRET_KEY  ?? '';
const HF_TOKEN        = process.env.HF_TOKEN        ?? '';

const missing = [
  ['S3_BUCKET',      S3_BUCKET],
  ['AWS_ACCESS_KEY', AWS_ACCESS_KEY],
  ['AWS_SECRET_KEY', AWS_SECRET_KEY],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

// ── golem-ts-bridge //v1 double-slash workaround ──────────────────────────────
// The golem CLI's `-E release` (custom server) config normalizes the server URL
// with a trailing slash; golem-ts-bridge concatenates `${baseUrl}/v1/...` verbatim, producing
// "http://localhost:9881//v1/agents/create-agent". Patch it at the fetch layer.
const _origFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) => {
  if (typeof input === 'string') input = input.replace(/([^:])\/\/v1\//, '$1/v1/');
  return _origFetch(input, init);
};

// ── FIXTURE FILES — colocated with this script in workflows/<name>/ ───────────
const _path = require('node:path') as typeof import('node:path');
const WORK_DIR          = process.env.WORK_DIR ?? '/work';
const FIXTURE_DIR       = _path.join(WORK_DIR, 'workflows', WF_NAME);
const S3_FIXTURE_PREFIX = `e2e-fixtures/${WF_NAME}`;

// Pixel size of reference_image.png. Reference mode must return exactly this as anchor_preview;
// prompt mode renders the anchor at a DIFFERENT size (PROMPT_ANCHOR_*), so the two are tellable apart.
const REFERENCE_WIDTH  = 1280;
const REFERENCE_HEIGHT = 720;
const PROMPT_ANCHOR_WIDTH  = 1344;
const PROMPT_ANCHOR_HEIGHT = 768;

// Models are sourced from workflow.yaml via agent.loadFromContent() — no hardcoded WF_MODELS needed.

// ── Render profile ────────────────────────────────────────────────────────────
const COMPUTE = { backend: COMPUTE_BACKEND, gpuType: GPU_TYPE, timeoutSec: TIMEOUT_SEC, maxAttempts: 2 };
const RENDER_PROFILE = { tier: 'standard', profile: { compute: COMPUTE } };
// Draft-like profile: its video block overrides params NAMED width / height / fps. None of those
// may exist as a port of this bundle, so the sheet must come out unchanged (checked in scenario A).
const DRAFT_LIKE_PROFILE = {
  tier: 'draft',
  profile: { video: { width: 720, height: 480, fps: 8 }, compute: COMPUTE },
};

// ── S3 fixture helper ─────────────────────────────────────────────────────────
// Uploads fixture files to a stable, reusable S3 prefix; skips if already present.
const _crypto = require('node:crypto') as typeof import('node:crypto');
const _https  = require('node:https')  as typeof import('node:https');
const _nodeFs = require('node:fs')     as typeof import('node:fs');

function _s3PresignGet(key: string, expiresIn = 14400): string {
  const ts      = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const day     = ts.slice(0, 8);
  const host    = `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;
  const scope   = `${day}/${AWS_REGION}/s3/aws4_request`;
  const credEnc = encodeURIComponent(`${AWS_ACCESS_KEY}/${scope}`);
  const canonQuery = [
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${credEnc}`,
    `X-Amz-Date=${ts}`,
    `X-Amz-Expires=${expiresIn}`,
    `X-Amz-SignedHeaders=host`,
  ].join('&');
  const canonReq = ['GET', '/' + key, canonQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts      = ['AWS4-HMAC-SHA256', ts, scope,
    _crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');
  const hmac = (k: Buffer | string, d: string) => _crypto.createHmac('sha256', k).update(d).digest();
  const sigKey = hmac(hmac(hmac(hmac(`AWS4${AWS_SECRET_KEY}`, day), AWS_REGION), 's3'), 'aws4_request');
  const sig    = _crypto.createHmac('sha256', sigKey).update(sts).digest('hex');
  return `https://${host}/${key}?${canonQuery}&X-Amz-Signature=${sig}`;
}

function _s3Headers(method: string, key: string, body: Buffer, contentType?: string): Record<string, string> {
  const ts   = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const day  = ts.slice(0, 8);
  const host = `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;
  const hash = _crypto.createHash('sha256').update(body).digest('hex');
  const pairs: [string, string][] = [
    ['host', host], ['x-amz-content-sha256', hash], ['x-amz-date', ts],
  ];
  if (contentType) pairs.push(['content-type', contentType]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const signedHdrs = pairs.map(([k]) => k).join(';');
  const canonHdrs  = pairs.map(([k, v]) => `${k}:${v}`).join('\n') + '\n';
  const canonReq   = [method, '/' + key, '', canonHdrs, signedHdrs, hash].join('\n');
  const scope      = `${day}/${AWS_REGION}/s3/aws4_request`;
  const sts        = ['AWS4-HMAC-SHA256', ts, scope,
    _crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');
  const hmac = (k: Buffer | string, d: string) => _crypto.createHmac('sha256', k).update(d).digest();
  const sigKey = hmac(hmac(hmac(hmac(`AWS4${AWS_SECRET_KEY}`, day), AWS_REGION), 's3'), 'aws4_request');
  const sig    = _crypto.createHmac('sha256', sigKey).update(sts).digest('hex');
  return {
    ...Object.fromEntries(pairs),
    authorization: `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY}/${scope}, SignedHeaders=${signedHdrs}, Signature=${sig}`,
  };
}

function _s3Req(method: string, key: string, body: Buffer, contentType?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const hdrs: Record<string, string | number> = _s3Headers(method, key, body, contentType);
    if (body.length) hdrs['content-length'] = body.length;
    const req = _https.request(
      { hostname: `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`, path: '/' + key, method, headers: hdrs },
      (res: any) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    if (body.length) req.write(body);
    req.end();
  });
}

async function ensureFixture(s3Key: string, localPath: string, contentType = 'image/png'): Promise<string> {
  if ((await _s3Req('HEAD', s3Key, Buffer.alloc(0))) !== 200) {
    const data   = _nodeFs.readFileSync(localPath) as Buffer;
    const status = await _s3Req('PUT', s3Key, data, contentType);
    if (status !== 200) throw new Error(`S3 PUT failed for ${s3Key}: HTTP ${status}`);
    console.log(`  [upload] ${s3Key} (${data.length} bytes)`);
  } else {
    console.log(`  [skip]   ${s3Key}`);
  }
  return _s3PresignGet(s3Key);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const failures: string[] = [];

function check(name: string, cond: boolean, detail: string): void {
  console.log(`  ${cond ? '✓' : '✗'} ${name} — ${detail}`);
  if (!cond) failures.push(`${name}: ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function pollUntilDone(agent: WorkflowAgent, renderId: string): Promise<any> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let lastPhase = '';
  while (Date.now() < deadline) {
    const json = await agent.runStatus(renderId);
    const result = JSON.parse(json ?? 'null');
    if (!result) throw new Error(`runStatus returned null for renderId "${renderId}"`);
    if (result.phase !== lastPhase) {
      console.log(`    phase=${result.phase}  attempts=${result.attempts ?? 0}`);
      lastPhase = result.phase;
    }
    if (result.phase === 'succeeded') return result;
    if (result.phase === 'failed') {
      const f = result.failure ?? {};
      throw new Error(`render failed: kind=${f.kind ?? '?'} — ${f.message ?? '(no message)'}`);
    }
    await sleep(RENDER_POLL_MS);
  }
  throw new Error(`render timed out after ${RENDER_TIMEOUT_MS / 1000}s`);
}

// Magic-byte checks — not content-type or filename extension.
function _isMp4(b: Uint8Array): boolean {
  return b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
}
function _isMp3(b: Uint8Array): boolean {
  return b.length >= 3 && (
    (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
    (b[0] === 0xFF && (b[1] & 0xE2) === 0xE2)
  );
}
function _isPng(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
}
/** Pixel size from the PNG IHDR chunk (big-endian width/height at byte 16 / 20). */
function _pngSize(b: Uint8Array): { width: number; height: number } {
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}
function _hexHead(b: Uint8Array, n = 8): string {
  return Array.from(b.slice(0, n)).map(x => x.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Verifies a finished render: EVERY declared output port is present exactly once (matched by
 * nodeId, else by the `<port>.<ext>` filename stem — nodeId is unreliable on some backends) and
 * is a well-formed file of its kind. Returns the downloaded bytes by port name.
 */
async function verifyOutputs(label: string, result: any, manifest: any): Promise<Record<string, Uint8Array>> {
  const bytes: Record<string, Uint8Array> = {};
  const declared: any[] = manifest.outputs ?? [];
  check(`${label}: all ${declared.length} declared outputs returned`, (result.outputs?.length ?? 0) === declared.length,
    `expected ${declared.length}, got ${result.outputs?.length ?? 0}`);
  for (const port of declared) {
    const out = (result.outputs ?? []).find((o: any) =>
      (o.nodeId != null && String(o.nodeId) === String(port.nodeId)) ||
      (o.filename ?? '').replace(/\.[^./]+$/, '') === port.name);
    check(`${label}: output ${port.name} present`, !!out, out ? out.filename : 'missing');
    if (!out) continue;
    const r = await fetch(out.url);
    check(`${label}: ${port.name} accessible`, r.ok, `HTTP ${r.status}`);
    const raw = new Uint8Array(await r.arrayBuffer());
    bytes[port.name] = raw;
    if (port.kind === 'video') check(`${label}: ${port.name} is MP4`, _isMp4(raw), `magic=${_hexHead(raw)}`);
    else if (port.kind === 'audio') check(`${label}: ${port.name} is MP3`, _isMp3(raw), `magic=${_hexHead(raw)}`);
    else if (port.kind === 'image') check(`${label}: ${port.name} is PNG`, _isPng(raw), `magic=${_hexHead(raw)}`);
  }
  return bytes;
}

// ── Agent ─────────────────────────────────────────────────────────────────────
const agent = await WorkflowAgent.get(WF_NAME, `e2e-${WF_NAME}-${Date.now()}`);

async function teardownAll(): Promise<void> {
  console.log('\n── Teardown ─────────────────────────────────────────────────────');
  try {
    await agent.teardown();
    console.log('  ✓ teardown() completed');
    const st = JSON.parse(await agent.backendStatus());
    check('status after teardown is not provisioned', st.status !== 'provisioned', st.status);
  } catch (err) {
    console.log(`  ✗ teardown() threw: ${err}`);
    failures.push(`teardown: ${err}`);
  }
}

// ── Test execution ────────────────────────────────────────────────────────────
try {
  console.log(`=== WorkflowAgent E2E — ${WF_NAME} ===\n`);

  // 1. Load workflow from bundle ─────────────────────────────────────────────
  console.log('── 1. Load workflow from bundle ─────────────────────────────');
  const _fs: { readFileSync: (p: string, enc: string) => string } = require('node:fs');
  const workflowJson = _fs.readFileSync(_path.join(FIXTURE_DIR, 'workflow.json'), 'utf8');
  const workflowYaml = _fs.readFileSync(_path.join(FIXTURE_DIR, 'workflow.yaml'), 'utf8');
  check('workflow.json loaded', workflowJson.length > 0, `${workflowJson.length} bytes`);
  check('workflow.yaml loaded', workflowYaml.length > 0, `${workflowYaml.length} bytes`);

  // Routes through WorkflowDownloader.buildEntryFromContent() — same path as production workspace.
  const slimManifestJson = await agent.loadFromContent(WF_NAME, workflowJson, workflowYaml);
  const manifest = JSON.parse(slimManifestJson);
  if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
  console.log(`  Loaded: inputs=${manifest.inputs?.length ?? 0} outputs=${manifest.outputs?.length ?? 0}`);
  check('manifest id matches', manifest.id === WF_NAME, manifest.id ?? '(null)');
  check('has primary output', manifest.outputs?.some((o: any) => o.role === 'primary'), JSON.stringify(manifest.outputs));
  const inputNames: string[] = (manifest.inputs ?? []).map((i: any) => i.name);
  const paramNames: string[] = (manifest.params ?? []).map((p: any) => p.name);
  const refInput = manifest.inputs?.find((i: any) => i.name === 'reference_image');
  check('reference_image input is declared', !!refInput, JSON.stringify(inputNames));
  check('reference_image is an optional image', refInput?.kind === 'image' && refInput?.required === false, JSON.stringify(refInput));
  check('anchor_width / anchor_height params exist', paramNames.includes('anchor_width') && paramNames.includes('anchor_height'), JSON.stringify(paramNames));
  // Profiles override params named width / height / fps / steps / seed / cfg / sampler: the first three
  // must NOT be ports here (fps is hard-wired to the model-native 24, the orbit size is fixed).
  check('no width / height / fps params (profile-proof)', !['width', 'height', 'fps'].some(n => paramNames.includes(n)), JSON.stringify(paramNames));
  const seedParam = manifest.params?.find((p: any) => p.name === 'seed');
  check('has numeric seed param', seedParam?.seed === true && seedParam?.kind === 'int', JSON.stringify(seedParam));

  // 1b. Pre-flight: verify model URLs from YAML before spending GPU budget ────
  console.log('\n── 1b. Pre-flight: verify model URLs ─────────────────────────────');
  const _yaml: { parse: (input: string) => any } = require('yaml');
  const parsedYaml = _yaml.parse(workflowYaml);
  for (const model of (parsedYaml.models ?? [])) {
    for (const f of (model.files ?? [])) {
      const url = f.url as string;
      if (!url) { console.log(`  [skip] ${model.name} — no public URL`); continue; }
      const headers: Record<string, string> = {};
      if (url.includes('huggingface.co') && HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`;
      const resp = await fetch(url, { method: 'HEAD', redirect: 'follow', headers });
      check(`${model.name} URL resolves`, resp.ok, `HTTP ${resp.status} — ${url.slice(0, 80)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Pre-flight failed:\n${failures.join('\n')}`);

  // 2. Provision ───────────────────────────────────────────────────────────────
  console.log('\n── 2. Provision ' + GPU_TYPE + ' endpoint ─────────────────────');
  await agent.provision();
  const provDeadline = Date.now() + PROVISION_TIMEOUT_MS;
  let provSummary: any = null;
  while (Date.now() < provDeadline) {
    const st = JSON.parse(await agent.backendStatus());
    if (st.status === 'provisioned') { provSummary = st; break; }
    if (st.status === 'failed') throw new Error(`Provisioning failed: ${st.error}`);
    console.log(`  [${st.status}] dc=${st.dcIndex ?? 0}/${st.dcTotal ?? '?'}`);
    await sleep(25_000);
  }
  if (!provSummary) throw new Error(`Provision timed out after ${PROVISION_TIMEOUT_MS / 60_000} min`);
  check('provisioned', provSummary.status === 'provisioned', provSummary.status);

  // 3. Stage fixture files ─────────────────────────────────────────────────────
  console.log('\n── 3. Stage fixture files in S3 ─────────────────────────────────');
  const promptText = _nodeFs.readFileSync(_path.join(FIXTURE_DIR, 'prompt_location.txt'), 'utf-8').toString().trim();
  const referenceImageUrl = await ensureFixture(`${S3_FIXTURE_PREFIX}/reference_image.png`, _path.join(FIXTURE_DIR, 'reference_image.png'));
  const fixtureSize = _pngSize(new Uint8Array(_nodeFs.readFileSync(_path.join(FIXTURE_DIR, 'reference_image.png')) as Buffer));
  check('fixture reference_image.png has the expected size', fixtureSize.width === REFERENCE_WIDTH && fixtureSize.height === REFERENCE_HEIGHT, `${fixtureSize.width}x${fixtureSize.height}`);

  // 4. Scenario A — prompt mode (no reference_image) ─────────────────────────
  // KREA-2 generates the anchor at PROMPT_ANCHOR_*; the draft-like profile's video width / height /
  // fps overrides must leave the sheet untouched.
  console.log('\n── 4. Scenario A: prompt mode (profile overrides must not leak) ──');
  const promptRenderId = await agent.run(
    JSON.stringify(DRAFT_LIKE_PROFILE),
    JSON.stringify({}),
    JSON.stringify({
      prompt_location: promptText,
      anchor_width: PROMPT_ANCHOR_WIDTH,
      anchor_height: PROMPT_ANCHOR_HEIGHT,
      seed: 42,
      steps: 8,
      frames: 124,
    }),
    undefined,  // promiseId
    undefined,  // promiseTimeoutMs
    undefined,  // loraJson
    undefined,  // notifyJson
  );
  console.log(`  renderId=${promptRenderId}`);
  check('prompt-mode renderId non-empty', promptRenderId.length > 0, promptRenderId);
  const promptResult = await pollUntilDone(agent, promptRenderId);
  check('prompt-mode render succeeded', promptResult.phase === 'succeeded', `phase=${promptResult.phase}`);
  const promptBytes = await verifyOutputs('prompt mode', promptResult, manifest);
  if (promptBytes['anchor_preview'] && _isPng(promptBytes['anchor_preview'])) {
    const s = _pngSize(promptBytes['anchor_preview']);
    check('prompt mode: anchor_preview is the KREA-2 anchor at anchor_width x anchor_height (profile 720x480 ignored)',
      s.width === PROMPT_ANCHOR_WIDTH && s.height === PROMPT_ANCHOR_HEIGHT, `${s.width}x${s.height}`);
  }

  // 5. Scenario B — reference mode (reference_image, no prompt) ──────────────
  // The image is the anchor; the KREA-2 stage is skipped. Absent optional ports elsewhere are not
  // involved; here the loader is bound, the soft switch picks it, anchor_preview echoes it.
  console.log('\n── 5. Scenario B: reference mode (reference_image, no prompt) ────');
  const referenceRenderId = await agent.run(
    JSON.stringify(RENDER_PROFILE),
    JSON.stringify({ reference_image: referenceImageUrl }),
    JSON.stringify({ seed: 42, frames: 124 }),
    undefined,  // promiseId
    undefined,  // promiseTimeoutMs
    undefined,  // loraJson
    undefined,  // notifyJson
  );
  console.log(`  renderId=${referenceRenderId}`);
  check('reference-mode renderId non-empty', referenceRenderId.length > 0, referenceRenderId);
  check('reference-mode renderId differs from prompt mode', referenceRenderId !== promptRenderId, referenceRenderId);
  const referenceResult = await pollUntilDone(agent, referenceRenderId);
  check('reference-mode render succeeded', referenceResult.phase === 'succeeded', `phase=${referenceResult.phase}`);
  const referenceBytes = await verifyOutputs('reference mode', referenceResult, manifest);
  if (referenceBytes['anchor_preview'] && _isPng(referenceBytes['anchor_preview'])) {
    const s = _pngSize(referenceBytes['anchor_preview']);
    check('reference mode: anchor_preview is the supplied image (fixture pixel size, not a generated anchor)',
      s.width === REFERENCE_WIDTH && s.height === REFERENCE_HEIGHT, `${s.width}x${s.height}`);
  }

  console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED ✓' : failures.length + ' CHECK(S) FAILED ✗'} ===`);
  if (failures.length > 0) for (const f of failures) console.log(`  ✗ ${f}`);

} finally {
  await teardownAll();
  if (failures.length > 0) throw new Error(`${failures.length} e2e check(s) failed:\n${failures.join('\n')}`);
}
