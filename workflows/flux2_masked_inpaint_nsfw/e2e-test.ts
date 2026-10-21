/**
 * WorkflowAgent E2E — flux2_masked_inpaint_nsfw
 *
 * Masked inpaint (NSFW) on ONE l40s endpoint, three renders (SCENARIO_IDS=a,b restricts the run):
 *   mask_only                 base + soft mask, no reference: the masked bed area gets a new subject
 *   character_reference       + reference_image_2 (Brianna): only port 2 is supplied, so it is "Picture 1"
 *   place_and_character_gap   reference_image_1 + reference_image_3 (port 2 absent): pictures 1 and 2
 * Every output must be a PNG of exactly 1248x832 (= the base) with
 *   - the area far from the mask pixel-exact (mean abs diff <= 1.0 vs the base) and
 *   - the mask core CHANGED (mean abs diff >= 6): the fixture mask is soft and peaks at ~70% grey, so
 *     this proves the bundle saturates the mask core (DifferentialDiffusion alone would keep the
 *     original pixels).
 * Plus manifest checks (capability masked-inpaint, mask input, optional references).
 * Fixtures: fixture_base_bedroom.png, fixture_mask_soft.png, fixture_character_brianna.png (in flux2_masked_inpaint/). Explicit content: run only where that is permitted.
 *
 * Cost: REAL GPU + S3. The script tears the endpoint down in `finally`; still verify no
 * orphaned provider resources afterwards (root CLAUDE.md "cloud resources").
 *
 * Run inside the harness container (standard fat-image deployment; `/tmp/deploy-app.env` holds the
 * deployed golem env name, single quotes keep `$(cat ...)` inside the container):
 *   docker exec -it harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/flux2_masked_inpaint_nsfw/e2e-test.ts --yes'
 *
 * Dev-tree fallback (local golem server, not via fat image; fork golem binary):
 *   cd video-harness && source .env && export WORK_DIR="$(cd .. && pwd)" && \
 *     golem -L repl --script-file ../workflows/flux2_masked_inpaint_nsfw/e2e-test.ts --yes
 */

// ── CONFIG — change these to adapt to a different workflow ───────────────────
const WF_NAME             = "flux2_masked_inpaint_nsfw";
const GPU_TYPE            = "l40s";  // FLUX.2 Klein 9B-KV needs ~29 GB VRAM (BFL model card) — rtx4090/rtx3090 (24 GB) insufficient; rtx5090 has no deployed pool on any backend in this repo
const TIMEOUT_SEC          = 5400;
const PROVISION_TIMEOUT_MS = 1500000;    // ~25 min
const RENDER_TIMEOUT_MS    = 2700000;        // ~45 min; ~18.8 GB total model download (flux-2-klein-9b-kv-fp8 9.8GB + qwen_3_8b_fp8mixed 8.7GB + flux2-vae 0.3GB)
const RENDER_POLL_MS       = 30_000;

const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND ?? 'modal';
const S3_BUCKET       = process.env.S3_BUCKET       ?? '';
const AWS_REGION      = process.env.AWS_REGION      ?? 'us-east-1';
const AWS_ACCESS_KEY  = process.env.AWS_ACCESS_KEY  ?? '';
const AWS_SECRET_KEY  = process.env.AWS_SECRET_KEY  ?? '';
const HF_TOKEN        = process.env.HF_TOKEN        ?? '';  // needed for gated HuggingFace models

const missing = [
  ['S3_BUCKET',      S3_BUCKET],
  ['AWS_ACCESS_KEY', AWS_ACCESS_KEY],
  ['AWS_SECRET_KEY', AWS_SECRET_KEY],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

// ── golem-ts-bridge //v1 double-slash workaround ──────────────────────────────
// The golem CLI's `-E release` (custom server) config normalizes the server URL
// with a trailing slash (e.g. "http://localhost:9881/"); golem-ts-bridge's
// createAgent()/invokeAgent() concatenate `${baseUrl}/v1/...` verbatim, producing
// "http://localhost:9881//v1/agents/create-agent". The fat-image container has no
// nginx in front of golem to normalize this (unlike the docker-compose dev stack),
// so every agent RPC 404s with "Not Found, not found". Patch it at the fetch layer.
const _origFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) => {
  if (typeof input === 'string') input = input.replace(/([^:])\/\/v1\//, '$1/v1/');
  return _origFetch(input, init);
};

// ── FIXTURE FILES — colocated with this script in workflows/<name>/ ───────────
const _path = require('node:path') as typeof import('node:path');
// Fixture files (PNG/txt) are colocated with e2e-test.ts in the workflow bundle.
// /work is the bind-mount of $PWD inside the harness container (run.sh mounts
// $PWD/workflows as /work/workflows). Override WORK_DIR if your mount differs.
const WORK_DIR         = process.env.WORK_DIR ?? '/work';
const BUNDLE_DIR       = _path.join(WORK_DIR, 'workflows', WF_NAME);
// The sfw and nsfw bundles share one set of fixtures, kept in the sfw bundle.
const FIXTURE_DIR      = _path.join(WORK_DIR, 'workflows', 'flux2_masked_inpaint');
const S3_FIXTURE_PREFIX = `e2e-fixtures/${WF_NAME}`;

// Models are sourced from workflow.yaml via agent.loadFromContent() — no hardcoded WF_MODELS needed.
// URL pre-flight (section 1b) reads model URLs from the parsed YAML directly.

// ── Render profile ────────────────────────────────────────────────────────────
const RENDER_PROFILE = {
  tier: 'standard',
  profile: {
    compute: { backend: COMPUTE_BACKEND, gpuType: GPU_TYPE, timeoutSec: TIMEOUT_SEC, maxAttempts: 2 },
  },
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

async function pollUntilDone(agent: any, renderId: string): Promise<any> {
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


// ── Minimal PNG decoder (8-bit RGB / RGBA, non-interlaced) for pixel assertions ───
const _zlib = require('node:zlib') as typeof import('node:zlib');
interface Raster { width: number; height: number; channels: number; data: Uint8Array; }
function decodePng(buf: Uint8Array): Raster {
  const b = Buffer.from(buf);
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  const depth = b[24], colorType = b[25], interlace = b[28];
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (depth=${depth} colorType=${colorType} interlace=${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let p = 8; p < b.length;) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = _zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const pp = left + up - upLeft, pa = Math.abs(pp - left), pb = Math.abs(pp - up), pc = Math.abs(pp - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      data[y * stride + x] = (v + add) & 255;
    }
  }
  return { width, height, channels, data };
}

/** Mean absolute per-channel difference of two same-sized rasters inside the box [x0,x1) x [y0,y1). */
function meanAbsDiff(a: Raster, b: Raster, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) {
    sum += Math.abs(a.data[(y * a.width + x) * a.channels + c] - b.data[(y * b.width + x) * b.channels + c]);
    n++;
  }
  return sum / n;
}

function _isPng(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
}
function _hexHead(b: Uint8Array, n = 8): string {
  return Array.from(b.slice(0, n)).map(x => x.toString(16).padStart(2, '0')).join(' ');
}

// ── Test execution ────────────────────────────────────────────────────────────
type PortName = 'reference_image_1' | 'reference_image_2' | 'reference_image_3';
type Fixture = 'character' | 'place';

interface Scenario {
  id: string;
  refs: Partial<Record<PortName, Fixture>>;
  prompt: string;
}

const STYLE = "A children's comic illustration with bold ink outlines and flat colours. ";
const SCENARIOS: Scenario[] = [
  {
    id: 'mask_only',
    refs: {},
    prompt: STYLE + 'A grey tabby cat curled up asleep on the bed, in the same bedroom.',
  },
  {
    id: 'character_reference',
    refs: { reference_image_2: 'character' },
    // only port 2 is supplied, so it is "Picture 1"
    prompt: STYLE + 'Brianna from Picture 1 sits on the bed, smiling at the camera, in the same bedroom.',
  },
  {
    id: 'place_and_character_gap',
    refs: { reference_image_1: 'place', reference_image_3: 'character' },
    // port 2 is absent: port 3 is "Picture 2"
    prompt: STYLE + 'Brianna from Picture 2 lies on the bed in the bedroom from Picture 1, arms spread wide.',
  },
];

// The fixture frame is 1248x832 (multiples of 16): render at that size so the output matches the base.
const WIDTH = 1248, HEIGHT = 832;
// Boxes (x0, y0, x1, y1): the fixture mask is a soft ellipse around (560, 590), radius ~230, peak ~70% grey.
const CORE_BOX = [500, 540, 620, 640] as const;
const FAR_BOX = [1000, 20, 1200, 200] as const;  // the door: nowhere near the mask

try {
  console.log(`=== WorkflowAgent E2E — ${WF_NAME} ===\n`);

  // 1. Load workflow from bundle ─────────────────────────────────────────────
  console.log('── 1. Load workflow from bundle ─────────────────────────────');
  const _fs: { readFileSync: (p: string, enc: string) => string } = require('node:fs');
  const workflowJson = _fs.readFileSync(_path.join(BUNDLE_DIR, 'workflow.json'), 'utf8');
  const workflowYaml = _fs.readFileSync(_path.join(BUNDLE_DIR, 'workflow.yaml'), 'utf8');
  check('workflow.json loaded', workflowJson.length > 0, `${workflowJson.length} bytes`);
  check('workflow.yaml loaded', workflowYaml.length > 0, `${workflowYaml.length} bytes`);

  // Routes through WorkflowDownloader.buildEntryFromContent() — same path as production workspace.
  const slimManifestJson = await agent.loadFromContent(WF_NAME, workflowJson, workflowYaml);
  const manifest = JSON.parse(slimManifestJson);
  if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
  const inputOf = (n: string) => manifest.inputs?.find((i: any) => i.name === n);
  const paramOf = (n: string) => manifest.params?.find((p: any) => p.name === n);
  check('manifest id matches', manifest.id === WF_NAME, manifest.id ?? '(null)');
  check('has primary output', manifest.outputs?.some((o: any) => o.role === 'primary'), JSON.stringify(manifest.outputs));
  check('has numeric seed param', paramOf('seed')?.seed === true && paramOf('seed')?.kind === 'int', JSON.stringify(paramOf('seed')));
  check('capabilities = [masked-inpaint]', JSON.stringify(manifest.capabilities) === '["masked-inpaint"]', JSON.stringify(manifest.capabilities));
  check('content marker is nsfw', (manifest.content ?? 'sfw') === 'nsfw', String(manifest.content));
  check('base_image is the required subject', inputOf('base_image')?.required === true && inputOf('base_image')?.referenceRole === 'subject', JSON.stringify(inputOf('base_image')));
  check('mask_image is the required mask', inputOf('mask_image')?.required === true && inputOf('mask_image')?.referenceRole === 'mask', JSON.stringify(inputOf('mask_image')));
  for (const n of ['context_image', 'reference_image_1', 'reference_image_2', 'reference_image_3']) {
    check(`${n} is optional`, inputOf(n)?.required === false, JSON.stringify(inputOf(n)));
  }
  check('width/height are required params', paramOf('width')?.required === true && paramOf('height')?.required === true, JSON.stringify([paramOf('width'), paramOf('height')]));

  // 1b. Pre-flight: verify model URLs from YAML before spending GPU budget ────
  console.log('\n── 1b. Pre-flight: verify model URLs ────────────────────────────');
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
  if (failures.length > 0) throw new Error(`Model URL pre-flight failed:\n${failures.join('\n')}`);

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

  // 3. Stage fixture files in S3 ──────────────────────────────────────────────
  console.log('\n── 3. Stage fixture files in S3 ─────────────────────────────────');
  const baseFile = _path.join(FIXTURE_DIR, 'fixture_base_bedroom.png');
  const baseUrl = await ensureFixture(`${S3_FIXTURE_PREFIX}/fixture_base_bedroom.png`, baseFile);
  const fixtureUrls: Record<'base' | 'mask' | Fixture, string> = {
    base: baseUrl,
    mask: await ensureFixture(`${S3_FIXTURE_PREFIX}/fixture_mask_soft.png`, _path.join(FIXTURE_DIR, 'fixture_mask_soft.png')),
    character: await ensureFixture(`${S3_FIXTURE_PREFIX}/fixture_character_brianna.png`, _path.join(FIXTURE_DIR, 'fixture_character_brianna.png')),
    place: baseUrl,  // the place reference is the base frame itself (a location plate)
  };
  const baseRaster = decodePng(_nodeFs.readFileSync(baseFile) as Uint8Array);
  check('base fixture is 1248x832', baseRaster.width === WIDTH && baseRaster.height === HEIGHT, `${baseRaster.width}x${baseRaster.height}`);

  // 4. One render per scenario ─────────────────────────────────────────────────
  const only = (process.env.SCENARIO_IDS ?? '').split(',').filter(Boolean);
  for (const sc of SCENARIOS.filter(s => only.length === 0 || only.includes(s.id))) {
    console.log(`\n── 4. Render: ${sc.id} ─────────────────────────────────────────`);
    const media: Record<string, string> = { base_image: fixtureUrls.base, mask_image: fixtureUrls.mask };
    for (const [port, fx] of Object.entries(sc.refs)) media[port] = fixtureUrls[fx as Fixture];
    const renderId = await agent.run(
      JSON.stringify(RENDER_PROFILE),
      JSON.stringify(media),
      JSON.stringify({ prompt_positive: sc.prompt, width: WIDTH, height: HEIGHT, steps: 4, seed: 4242 }),
      undefined,  // promiseId
      undefined,  // promiseTimeoutMs
      undefined,  // loraJson
      undefined,  // notifyJson
    );
    check(`${sc.id}: renderId non-empty`, renderId.length > 0, renderId);
    const result = await pollUntilDone(agent, renderId);
    check(`${sc.id}: render succeeded`, result.phase === 'succeeded', `phase=${result.phase}`);
    check(`${sc.id}: returned the declared output`, result.outputs?.length === 1, `got ${result.outputs?.length}`);
    for (const out of result.outputs ?? []) {
      console.log(`  ${out.filename ?? 'output'}: ${out.url}`);
      const r = await fetch(out.url);
      check(`${sc.id}: output accessible`, r.ok, `HTTP ${r.status}`);
      const raw = new Uint8Array(await r.arrayBuffer());
      check(`${sc.id}: output is PNG`, _isPng(raw), `magic=${_hexHead(raw)}`);
      if (!_isPng(raw)) continue;
      const png = decodePng(raw);
      check(`${sc.id}: output is ${WIDTH}x${HEIGHT}`, png.width === WIDTH && png.height === HEIGHT, `${png.width}x${png.height}`);
      if (png.width !== WIDTH || png.height !== HEIGHT) continue;
      const far = meanAbsDiff(png, baseRaster, ...FAR_BOX);
      const core = meanAbsDiff(png, baseRaster, ...CORE_BOX);
      check(`${sc.id}: far from the mask is pixel-exact`, far <= 1.0, `mean abs diff ${far.toFixed(2)}`);
      check(`${sc.id}: soft mask core was regenerated (saturated core)`, core >= 6, `mean abs diff ${core.toFixed(2)}`);
    }
  }

  console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED ✓' : failures.length + ' CHECK(S) FAILED ✗'} ===`);
  if (failures.length > 0) for (const f of failures) console.log(`  ✗ ${f}`);

} finally {
  await teardownAll();
  if (failures.length > 0) throw new Error(`${failures.length} e2e check(s) failed:\n${failures.join('\n')}`);
}
