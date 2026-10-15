/**
 * WorkflowAgent E2E — flux2_reference_compose_nsfw (ref2i, NSFW: new image from up to 3 references)
 *
 * Three renders on ONE provisioned l40s endpoint, submitted together (E2E_ONLY=A|B|C runs just one):
 *   A. solo:   plate (Picture 1) + woman (Picture 2) -> nude woman on the bed       -> out_solo.png
 *   B. couple: plate + woman + man (Picture 3), missionary sex act, prompt only     -> out_couple.png
 *   C. LoRA:   as B plus catalog LoRA FK_missionary on port lora_1 (strength 0.8,
 *              passed as the 6th agent.run() argument)                              -> out_lora.png
 * Plus manifest checks (3 optional image inputs, lora_1..lora_4 ports, primary `image` output).
 * A general NSFW LoRA (SNOFS) is baked into the graph. Each output must be a PNG of exactly
 * 1344x768 and is saved next to this script for visual review. Model URLs come from workflow.yaml.
 * Fixtures: fixture_*.png (this folder). Explicit content: run only where that is permitted.
 *
 * Cost: REAL GPU + S3. The script tears the endpoint down in `finally`; still verify no
 * orphaned provider resources afterwards (root CLAUDE.md "cloud resources").
 *
 * Run inside the harness container (standard fat-image deployment; `/tmp/deploy-app.env` holds the
 * deployed golem env name, single quotes keep `$(cat ...)` inside the container):
 *   docker exec -it harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/flux2_reference_compose_nsfw/e2e-test.ts --yes'
 *
 * Dev-tree fallback (local golem server, not via fat image; fork golem binary):
 *   cd video-harness && source .env && export WORK_DIR="$(cd .. && pwd)" && \
 *     golem -L repl --script-file ../workflows/flux2_reference_compose_nsfw/e2e-test.ts --yes
 */

// ── CONFIG — change these to adapt to a different workflow ───────────────────
const WF_NAME             = "flux2_reference_compose_nsfw";
const GPU_TYPE            = "l40s";  // FLUX.2 Klein 9B-KV needs ~29 GB VRAM — rtx4090/rtx3090 (24 GB) insufficient
const TIMEOUT_SEC          = 5400;
const PROVISION_TIMEOUT_MS = 1500000;    // ~25 min
const RENDER_TIMEOUT_MS    = 2700000;    // ~45 min; includes first-time model downloads
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

// ── Paths, fixtures, scenarios ────────────────────────────────────────────────
const _path   = require('node:path')   as typeof import('node:path');
const _crypto = require('node:crypto') as typeof import('node:crypto');
const _https  = require('node:https')  as typeof import('node:https');
const _nodeFs = require('node:fs')     as typeof import('node:fs');

// Fixture files are colocated with e2e-test.ts in the workflow bundle.
// /work is the bind-mount of $PWD inside the harness container (run.sh mounts
// $PWD/workflows as /work/workflows). Override WORK_DIR if your mount differs.
const WORK_DIR          = process.env.WORK_DIR ?? '/work';
const FIXTURE_DIR       = _path.join(WORK_DIR, 'workflows', WF_NAME);
const S3_FIXTURE_PREFIX = `e2e-fixtures/${WF_NAME}`;

const WIDTH  = 1344;
const HEIGHT = 768;
const SEED   = 4242;

const PLATE_FIXTURE          = 'fixture_plate.png';           // an empty hotel bedroom
const WOMAN_FIXTURE          = 'fixture_character.png';       // an adult red-haired woman
const MAN_FIXTURE            = 'fixture_character_male.png';  // an adult dark-haired bearded man

type PortName = 'reference_image_1' | 'reference_image_2' | 'reference_image_3';

const LORA_NAME   = 'FK_missionary.safetensors';
const LORA_SHA256 = '787faf79194659dba26bea0adba67b48e32ece24172544229116a9f680aef4a1';
const LORA_JSON = JSON.stringify({
  selections: { lora_1: { loraName: LORA_NAME, strength: 0.8 } },
  models: [{
    folder: 'loras',
    name: LORA_NAME,
    url: `https://s3.us-east-1.amazonaws.com/auteur-model-cache-20260905193718168400000001/public/lora/${LORA_SHA256}/${LORA_NAME}`,
    sha256: LORA_SHA256,
  }],
});

const SOLO_PROMPT =
  'The adult red-haired woman of Picture 2 (her exact face, hair, skin and body) lies nude on her side on the bed in the hotel bedroom of Picture 1 ' +
  '(same bed, lamps, window and camera angle), propped on one elbow, looking at the camera. Photographic.';
const COUPLE_PROMPT =
  'The adult red-haired woman of Picture 2 (her exact face, hair, skin and body) and the adult dark-haired bearded man of Picture 3 ' +
  '(his exact face, hair, beard and body), both nude, having sex in the missionary position on the bed in the hotel bedroom of Picture 1 ' +
  '(same bed, lamps, window and camera angle): she lies on her back with her legs spread around him, he is on top between her legs, ' +
  'his penis inside her vagina. Side view of the bed, photographic.';

interface Scenario {
  label: string;
  /** Which fixture file feeds which port (an absent port is pruned from the graph by bindWorkflow()). */
  refs: Partial<Record<PortName, string>>;
  prompt: string;
  loraJson: string | undefined;
  outFile: string;
}

const ALL_SCENARIOS: Scenario[] = [
  { label: 'A solo', refs: { reference_image_1: PLATE_FIXTURE, reference_image_2: WOMAN_FIXTURE },
    prompt: SOLO_PROMPT, loraJson: undefined, outFile: 'out_solo.png' },
  { label: 'B couple act', refs: { reference_image_1: PLATE_FIXTURE, reference_image_2: WOMAN_FIXTURE, reference_image_3: MAN_FIXTURE },
    prompt: COUPLE_PROMPT, loraJson: undefined, outFile: 'out_couple.png' },
  { label: 'C catalog LoRA', refs: { reference_image_1: PLATE_FIXTURE, reference_image_2: WOMAN_FIXTURE, reference_image_3: MAN_FIXTURE },
    prompt: 'missionary, vaginal sex. ' + COUPLE_PROMPT, loraJson: LORA_JSON, outFile: 'out_lora.png' },
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

/** Polls one render to a terminal phase; never throws (a failed render must not abort the others). */
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

/** Checks the single `image` output: present, downloadable, PNG, exactly WIDTHxHEIGHT. Returns its bytes. */
async function verifyImage(label: string, result: any): Promise<Uint8Array | null> {
  const out = (result.outputs ?? []).find((o: any) =>
    (o.filename ?? '').replace(/\.[^./]+$/, '') === 'image') ?? (result.outputs ?? [])[0];
  check(`${label}: image returned`, !!out && (result.outputs?.length ?? 0) === 1, `${result.outputs?.length ?? 0} output(s)`);
  if (!out) return null;
  const r = await fetch(out.url);
  check(`${label}: image accessible`, r.ok, `HTTP ${r.status}`);
  const raw = new Uint8Array(await r.arrayBuffer());
  check(`${label}: image is PNG`, _isPng(raw), `${raw.length} bytes`);
  if (!_isPng(raw)) return null;
  const s = _pngSize(raw);
  check(`${label}: image is ${WIDTH}x${HEIGHT}`, s.width === WIDTH && s.height === HEIGHT, `${s.width}x${s.height}`);
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
  check('workflow.json loaded', workflowJson.length > 0, `${workflowJson.length} bytes`);
  check('workflow.yaml loaded', workflowYaml.length > 0, `${workflowYaml.length} bytes`);

  // Routes through WorkflowDownloader.buildEntryFromContent() — same path as production workspace.
  const manifest = JSON.parse(await agent.loadFromContent(WF_NAME, workflowJson, workflowYaml));
  if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
  const inputOf = (n: string): any => manifest.inputs?.find((i: any) => i.name === n);
  const paramOf = (n: string): any => manifest.params?.find((p: any) => p.name === n);
  console.log(`  Loaded: inputs=${manifest.inputs?.length ?? 0} outputs=${manifest.outputs?.length ?? 0}`);
  check('manifest id matches', manifest.id === WF_NAME, manifest.id ?? '(null)');
  const wfType = manifest.workflowType ?? manifest.workflow_type;
  check('is a ref2i workflow', wfType === 'ref2i', String(wfType));
  for (const n of ['reference_image_1', 'reference_image_2', 'reference_image_3']) {
    check(`${n} is an optional image input`, inputOf(n)?.kind === 'image' && inputOf(n)?.required === false, JSON.stringify(inputOf(n)));
  }
  check('width/height are required params', paramOf('width')?.required === true && paramOf('height')?.required === true, JSON.stringify([paramOf('width'), paramOf('height')]));
  check('seed is a numeric seed param', paramOf('seed')?.seed === true && paramOf('seed')?.kind === 'int', JSON.stringify(paramOf('seed')));

  // LoRA ports: tolerate whichever manifest section carries them (loras / inputs / params).
  const portNames = new Set<string>(
    [...(manifest.loras ?? []), ...(manifest.loraPorts ?? []), ...(manifest.lora_ports ?? []), ...(manifest.inputs ?? []), ...(manifest.params ?? [])]
      .map((p: any) => p.name));
  for (const n of ['lora_1', 'lora_2', 'lora_3', 'lora_4']) check(`lora port ${n} declared`, portNames.has(n), [...portNames].join(','));

  const outputNames: string[] = (manifest.outputs ?? []).map((o: any) => o.name);
  check('declares exactly the image output', outputNames.length === 1 && outputNames[0] === 'image', JSON.stringify(outputNames));
  check('image is the primary output', manifest.outputs?.[0]?.role === 'primary', JSON.stringify(manifest.outputs?.[0]));

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
  if (failures.length > 0) throw new Error(`Pre-flight failed:\n${failures.join('\n')}`);

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
    const media: Record<string, string> = {};
    for (const [port, file] of Object.entries(sc.refs)) media[port] = await stage(file as string);
    const id: string = await agent.run(
      JSON.stringify(RENDER_PROFILE),
      JSON.stringify(media),
      JSON.stringify({ prompt_positive: sc.prompt, width: WIDTH, height: HEIGHT, seed: SEED }),
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
    const bytes = await verifyImage(sc.label, outcome.result);
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
