/**
 * WorkflowAgent E2E — flux2_image_edit_nsfw
 *
 * Two FLUX.2 Klein 9B image edits of fixture_character.png (an adult woman, nude) on ONE provisioned l40s
 * endpoint, submitted together so they run concurrently (E2E_ONLY=A|B runs just one of them), seed 4242:
 *   A. edit, no LoRA:      change her pose (cross-legged on the floor)                       -> out_edit.png
 *   B. edit + catalog LoRA: as A plus klein_0x7_nsfw_edit_v2 ('no face change' nudity edit LoRA) on port
 *                          lora_1 (strength 0.8, passed as the 6th agent.run() argument)      -> out_lora.png
 * Plus manifest checks (subject_image required / garment_reference_image optional, lora_1..lora_4 ports,
 * edited_image output, content nsfw). A general NSFW LoRA (SNOFS) is baked into the graph. For each render:
 * phase succeeded, output returned, PNG of ~1 megapixel (the subject is scaled to 1 MP). Outputs are saved
 * next to this script for visual review.
 *
 * No bundle assets: the workflow is loaded with loadFromContent (workflow.json + workflow.yaml from disk).
 *
 * Cost: REAL GPU + S3 (the fixture is staged in S3; the first run downloads the full FLUX.2 Klein model set,
 * hence the 90 min provision timeout). Teardown runs in `finally`; still verify no orphaned provider
 * resources afterwards (root CLAUDE.md "cloud resources"). Needs S3_BUCKET / AWS_ACCESS_KEY / AWS_SECRET_KEY
 * (+ AWS_REGION); COMPUTE_BACKEND defaults to modal.
 *
 * Run inside the harness container (fat image; `/tmp/deploy-app.env` holds the deployed golem env name):
 *   docker exec -it harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/flux2_image_edit_nsfw/e2e-test.ts --yes'
 *
 * Dev-tree fallback (local golem server; fork golem binary):
 *   cd video-harness && source .env && export WORK_DIR="$(cd .. && pwd)" && \
 *     golem -L repl --script-file ../workflows/flux2_image_edit_nsfw/e2e-test.ts --yes
 */

// ── CONFIG ────────────────────────────────────────────────────────────────────
const WF_NAME              = "flux2_image_edit_nsfw";
const GPU_TYPE             = "l40s";
const TIMEOUT_SEC          = 3600;
const PROVISION_TIMEOUT_MS = 5400000;          // 90 min — first-run model download
const RENDER_TIMEOUT_MS    = 1200000;          // 20 min per render
const RENDER_POLL_MS       = 20_000;

const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND ?? 'modal';
const S3_BUCKET       = process.env.S3_BUCKET       ?? '';
const AWS_REGION      = process.env.AWS_REGION      ?? 'us-east-1';
const AWS_ACCESS_KEY  = process.env.AWS_ACCESS_KEY  ?? '';
const AWS_SECRET_KEY  = process.env.AWS_SECRET_KEY  ?? '';

const missing = [
  ['S3_BUCKET',      S3_BUCKET],
  ['AWS_ACCESS_KEY', AWS_ACCESS_KEY],
  ['AWS_SECRET_KEY', AWS_SECRET_KEY],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

// ── golem-ts-bridge //v1 double-slash workaround ──────────────────────────────
// The bridge concatenates `${baseUrl}/v1/...` verbatim while the CLI's server URL ends in "/".
const _origFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) => {
  if (typeof input === 'string') input = input.replace(/([^:])\/\/v1\//, '$1/v1/');
  return _origFetch(input, init);
};

// ── Paths, expected sizes ─────────────────────────────────────────────────────
const _path   = require('node:path')   as typeof import('node:path');
const _crypto = require('node:crypto') as typeof import('node:crypto');
const _https  = require('node:https')  as typeof import('node:https');
const _nodeFs = require('node:fs')     as typeof import('node:fs');

const WORK_DIR          = process.env.WORK_DIR ?? '/work';
const FIXTURE_DIR       = _path.join(WORK_DIR, 'workflows', WF_NAME);
const S3_FIXTURE_PREFIX = `e2e-fixtures/${WF_NAME}`;

const SEED   = 4242;
const MIN_MEGAPIXELS = 0.9;   // the subject is scaled to 1 MP (ImageScaleToTotalPixels), output follows its size
const MAX_MEGAPIXELS = 1.1;

const SUBJECT_FIXTURE = 'fixture_character.png';  // an adult woman, nude

const EDIT_PROMPT =
  'Change her pose: she now sits cross-legged on the floor, hands on her knees, looking at the camera. ' +
  'Keep her exact face, red hair, skin and body and the plain backdrop.';

const LORA_NAME   = 'klein_0x7_nsfw_edit_v2.safetensors';
const LORA_SHA256 = '0209eddba9755ba209145ab800fd028164f74cfdc1739f96f288d22e851de5f7';
const LORA_JSON = JSON.stringify({
  selections: { lora_1: { loraName: LORA_NAME, strength: 0.8 } },
  models: [{
    folder: 'loras',
    name: LORA_NAME,
    url: `https://s3.us-east-1.amazonaws.com/auteur-model-cache-20260905193718168400000001/public/lora/${LORA_SHA256}/${LORA_NAME}`,
    sha256: LORA_SHA256,
  }],
});

interface Scenario {
  label: string;
  prompt: string;
  loraJson: string | undefined;
  outFile: string;
}
const ALL_SCENARIOS: Scenario[] = [
  { label: 'A edit',          prompt: EDIT_PROMPT, loraJson: undefined, outFile: 'out_edit.png' },
  { label: 'B catalog LoRA',  prompt: EDIT_PROMPT, loraJson: LORA_JSON, outFile: 'out_lora.png' },
];

const ONLY = process.env.E2E_ONLY ?? '';
const SCENARIOS = ALL_SCENARIOS.filter(sc => !ONLY || sc.label.startsWith(ONLY));

const COMPUTE = { backend: COMPUTE_BACKEND, gpuType: GPU_TYPE, timeoutSec: TIMEOUT_SEC, maxAttempts: 2 };
const RENDER_PROFILE = { tier: 'standard', profile: { compute: COMPUTE } };

// ── S3 fixture helper (SigV4; uploads once to a stable prefix, returns a presigned GET URL) ──
function _hmac(k: Buffer | string, d: string): Buffer {
  return _crypto.createHmac('sha256', k).update(d).digest();
}
function _sigKey(day: string): Buffer {
  return _hmac(_hmac(_hmac(_hmac(`AWS4${AWS_SECRET_KEY}`, day), AWS_REGION), 's3'), 'aws4_request');
}
function _amzDate(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
const S3_HOST = `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;

function _s3PresignGet(key: string, expiresIn = 14400): string {
  const ts = _amzDate();
  const day = ts.slice(0, 8);
  const scope = `${day}/${AWS_REGION}/s3/aws4_request`;
  const canonQuery = [
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${encodeURIComponent(`${AWS_ACCESS_KEY}/${scope}`)}`,
    `X-Amz-Date=${ts}`,
    `X-Amz-Expires=${expiresIn}`,
    `X-Amz-SignedHeaders=host`,
  ].join('&');
  const canonReq = ['GET', '/' + key, canonQuery, `host:${S3_HOST}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', ts, scope, _crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');
  const sig = _crypto.createHmac('sha256', _sigKey(day)).update(sts).digest('hex');
  return `https://${S3_HOST}/${key}?${canonQuery}&X-Amz-Signature=${sig}`;
}

function _s3Headers(method: string, key: string, body: Buffer, contentType?: string): Record<string, string> {
  const ts = _amzDate();
  const day = ts.slice(0, 8);
  const hash = _crypto.createHash('sha256').update(body).digest('hex');
  const pairs: [string, string][] = [['host', S3_HOST], ['x-amz-content-sha256', hash], ['x-amz-date', ts]];
  if (contentType) pairs.push(['content-type', contentType]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const signedHdrs = pairs.map(([k]) => k).join(';');
  const canonHdrs  = pairs.map(([k, v]) => `${k}:${v}`).join('\n') + '\n';
  const canonReq   = [method, '/' + key, '', canonHdrs, signedHdrs, hash].join('\n');
  const scope      = `${day}/${AWS_REGION}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', ts, scope, _crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');
  const sig = _crypto.createHmac('sha256', _sigKey(day)).update(sts).digest('hex');
  return {
    ...Object.fromEntries(pairs),
    authorization: `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY}/${scope}, SignedHeaders=${signedHdrs}, Signature=${sig}`,
  };
}

function _s3Req(method: string, key: string, body: Buffer, contentType?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const hdrs: Record<string, string | number> = _s3Headers(method, key, body, contentType);
    if (body.length) hdrs['content-length'] = body.length;
    const req = _https.request({ hostname: S3_HOST, path: '/' + key, method, headers: hdrs },
      (res: any) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    if (body.length) req.write(body);
    req.end();
  });
}

async function ensureFixture(s3Key: string, localPath: string): Promise<string> {
  if ((await _s3Req('HEAD', s3Key, Buffer.alloc(0))) !== 200) {
    const data = _nodeFs.readFileSync(localPath) as Buffer;
    const status = await _s3Req('PUT', s3Key, data, 'image/png');
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
function _isPng(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
}
interface PngSize { width: number; height: number }
/** Pixel size from the PNG IHDR chunk (big-endian width/height at byte 16 / 20). */
function _pngSize(b: Uint8Array): PngSize {
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

interface RenderSucceeded { ok: true; result: any }
interface RenderFailed { ok: false; error: string }
type RenderOutcome = RenderSucceeded | RenderFailed;

/** Polls one render to a terminal phase; never throws (a failed render must not abort the other). */
async function pollUntilDone(agent: WorkflowAgent, label: string, renderId: string): Promise<RenderOutcome> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let lastPhase = '';
  while (Date.now() < deadline) {
    const result = JSON.parse((await agent.runStatus(renderId)) ?? 'null');
    if (!result) return { ok: false, error: `runStatus returned null for "${renderId}"` };
    if (result.phase !== lastPhase) {
      console.log(`    [${label}] phase=${result.phase}  attempts=${result.attempts ?? 0}`);
      lastPhase = result.phase;
    }
    if (result.phase === 'succeeded') return { ok: true, result };
    if (result.phase === 'failed') {
      const f = result.failure ?? {};
      return { ok: false, error: `kind=${f.kind ?? '?'} — ${f.message ?? '(no message)'}` };
    }
    await sleep(RENDER_POLL_MS);
  }
  return { ok: false, error: `timed out after ${RENDER_TIMEOUT_MS / 1000}s` };
}

/** Checks the single edited_image output: present, downloadable, PNG, about 1 megapixel. Returns its bytes. */
async function verifyEditedImage(label: string, result: any): Promise<Uint8Array | null> {
  const out = (result.outputs ?? []).find((o: any) =>
    (o.filename ?? '').replace(/\.[^./]+$/, '') === 'edited_image') ?? (result.outputs ?? [])[0];
  check(`${label}: edited_image returned`, !!out && (result.outputs?.length ?? 0) === 1, `${result.outputs?.length ?? 0} output(s)`);
  if (!out) return null;
  const r = await fetch(out.url);
  check(`${label}: edited_image accessible`, r.ok, `HTTP ${r.status}`);
  const raw = new Uint8Array(await r.arrayBuffer());
  check(`${label}: edited_image is PNG`, _isPng(raw), `${raw.length} bytes`);
  if (!_isPng(raw)) return null;
  const s = _pngSize(raw);
  const mp = (s.width * s.height) / 1e6;
  check(`${label}: edited_image is ~1 MP`, mp >= MIN_MEGAPIXELS && mp <= MAX_MEGAPIXELS, `${s.width}x${s.height} = ${mp.toFixed(2)} MP`);
  return raw;
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

  // 1. Load workflow + manifest checks ─────────────────────────────────────────
  console.log('── 1. Load workflow from bundle ─────────────────────────────');
  const workflowJson = _nodeFs.readFileSync(_path.join(FIXTURE_DIR, 'workflow.json'), 'utf8') as string;
  const workflowYaml = _nodeFs.readFileSync(_path.join(FIXTURE_DIR, 'workflow.yaml'), 'utf8') as string;
  const manifest = JSON.parse(await agent.loadFromContent(WF_NAME, workflowJson, workflowYaml));
  if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
  check('manifest id matches', manifest.id === WF_NAME, manifest.id ?? '(null)');
  check('workflow_type is i2i', (manifest.workflowType ?? manifest.workflow_type) === 'i2i', String(manifest.workflowType ?? manifest.workflow_type));
  check('model_family is flux2', (manifest.modelFamily ?? manifest.model_family) === 'flux2', String(manifest.modelFamily ?? manifest.model_family));
  check('content is nsfw', manifest.content === 'nsfw', String(manifest.content));

  const inputByName = (n: string): any => manifest.inputs?.find((i: any) => i.name === n);
  check('subject_image is a required image input', inputByName('subject_image')?.kind === 'image' && inputByName('subject_image')?.required === true, JSON.stringify(inputByName('subject_image')));
  check('garment_reference_image is an optional image input', inputByName('garment_reference_image')?.kind === 'image' && inputByName('garment_reference_image')?.required === false, JSON.stringify(inputByName('garment_reference_image')));

  // LoRA ports: tolerate whichever manifest section carries them (loras / inputs / params).
  const portNames = new Set<string>(
    [...(manifest.loras ?? []), ...(manifest.loraPorts ?? []), ...(manifest.lora_ports ?? []), ...(manifest.inputs ?? []), ...(manifest.params ?? [])]
      .map((p: any) => p.name));
  for (const n of ['lora_1', 'lora_2', 'lora_3', 'lora_4']) check(`lora port ${n} declared`, portNames.has(n), [...portNames].join(','));

  const paramByName = (n: string): any => manifest.params?.find((p: any) => p.name === n);
  check('prompt_positive is a required string', paramByName('prompt_positive')?.kind === 'string' && paramByName('prompt_positive')?.required === true, JSON.stringify(paramByName('prompt_positive')));
  check('seed is a numeric seed param', paramByName('seed')?.seed === true && paramByName('seed')?.kind === 'int', JSON.stringify(paramByName('seed')));
  for (const n of ['steps', 'cfg']) check(`param ${n} is declared`, !!paramByName(n), JSON.stringify(paramByName(n)));

  const outputNames: string[] = (manifest.outputs ?? []).map((o: any) => o.name);
  check('declares exactly the edited_image output', outputNames.length === 1 && outputNames[0] === 'edited_image', JSON.stringify(outputNames));
  check('edited_image is the primary output', manifest.outputs?.[0]?.role === 'primary', JSON.stringify(manifest.outputs?.[0]));

  // 2. Provision ───────────────────────────────────────────────────────────────
  console.log('\n── 2. Provision ' + GPU_TYPE + ' endpoint ─────────────────────');
  await agent.provision();
  const provDeadline = Date.now() + PROVISION_TIMEOUT_MS;
  let provisioned = false;
  while (Date.now() < provDeadline) {
    const st = JSON.parse(await agent.backendStatus());
    if (st.status === 'provisioned') { provisioned = true; break; }
    if (st.status === 'failed') throw new Error(`Provisioning failed: ${st.error}`);
    console.log(`  [${st.status}] dc=${st.dcIndex ?? 0}/${st.dcTotal ?? '?'}`);
    await sleep(25_000);
  }
  if (!provisioned) throw new Error(`Provision timed out after ${PROVISION_TIMEOUT_MS / 60_000} min`);
  check('provisioned', true, 'provisioned');

  // 3. Stage fixtures, submit all renders together ─────────────────────────────
  console.log('\n── 3. Stage fixtures + submit renders ───────────────────────────');
  const fixtureUrls: Record<string, string> = {};
  const stage = async (file: string): Promise<string> =>
    (fixtureUrls[file] ??= await ensureFixture(`${S3_FIXTURE_PREFIX}/${file}`, _path.join(FIXTURE_DIR, file)));
  const renderIds: string[] = [];
  for (const sc of SCENARIOS) {
    const inputs: Record<string, string> = { subject_image: await stage(SUBJECT_FIXTURE) };
    const id: string = await agent.run(
      JSON.stringify(RENDER_PROFILE),
      JSON.stringify(inputs),
      JSON.stringify({ prompt_positive: sc.prompt, steps: 4, seed: SEED }),
      undefined,      // promiseId
      undefined,      // promiseTimeoutMs
      sc.loraJson,    // loraJson
      undefined,      // notifyJson
    );
    console.log(`  [${sc.label}] renderId=${id}`);
    check(`${sc.label}: renderId non-empty`, id.length > 0, id);
    renderIds.push(id);
  }
  check('render ids differ', new Set(renderIds).size === renderIds.length, renderIds.join(' vs '));

  // 4. Poll concurrently, then verify ──────────────────────────────────────────
  console.log('\n── 4. Poll renders (concurrent) ─────────────────────────────────');
  const outcomes = await Promise.all(SCENARIOS.map((sc, i) => pollUntilDone(agent, sc.label, renderIds[i])));

  console.log('\n── 5. Verify outputs ────────────────────────────────────────────');
  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];
    const outcome = outcomes[i];
    check(`${sc.label}: render succeeded`, outcome.ok, outcome.ok ? 'succeeded' : outcome.error);
    if (!outcome.ok) continue;
    const bytes = await verifyEditedImage(sc.label, outcome.result);
    if (bytes) {
      const outPath = _path.join(FIXTURE_DIR, sc.outFile);
      _nodeFs.writeFileSync(outPath, bytes);
      console.log(`  [${sc.label}] saved for visual review: ${outPath}`);
    }
  }

  console.log(`\n=== ${failures.length === 0 ? 'PASS — ALL CHECKS PASSED ✓' : 'FAIL — ' + failures.length + ' CHECK(S) FAILED ✗'} ===`);
  for (const f of failures) console.log(`  ✗ ${f}`);

} finally {
  await teardownAll();
  if (failures.length > 0) throw new Error(`${failures.length} e2e check(s) failed:\n${failures.join('\n')}`);
}
