/**
 * WorkflowAgent E2E — qwen_image_pose_transfer
 *
 * Pose transfer (SFW) on ONE endpoint, two renders (SCENARIO_IDS=a,b restricts the run):
 *   default_prompt        the trained AnyPose wording, subject = a standing woman, pose = a scene-free figure
 *   keep_outfit_prompt    the same plus "keep her face, hair, olive t-shirt and grey shorts from image 1"
 * Every output must be a PNG that DIFFERS from the subject image (the pose changed). The result is not
 * pixel-checked against a pose (that needs a pose model): look at the two output URLs. Plus manifest
 * checks (capability pose-transfer, two required image inputs).
 * Fixtures: fixture_subject.png (a standing woman), fixture_pose_reference.png (a synthetic scene-free
 * figure; for a real check render a neutral mannequin in the target pose) (this folder).
 *
 * Cost: REAL GPU + S3. The script tears the endpoint down in `finally`; still verify no
 * orphaned provider resources afterwards (root CLAUDE.md "cloud resources").
 *
 * Run inside the harness container (standard fat-image deployment; `/tmp/deploy-app.env` holds the
 * deployed golem env name, single quotes keep `$(cat ...)` inside the container):
 *   docker exec -it harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/qwen_image_pose_transfer/e2e-test.ts --yes'
 *
 * Dev-tree fallback (local golem server, not via fat image; fork golem binary):
 *   cd video-harness && source .env && export WORK_DIR="$(cd .. && pwd)" && \
 *     golem -L repl --script-file ../workflows/qwen_image_pose_transfer/e2e-test.ts --yes
 */

// ── CONFIG — change these to adapt to a different workflow ───────────────────
const WF_NAME             = "qwen_image_pose_transfer";
const GPU_TYPE            = "rtx3090";  // same as qwen_image_multi_edit: Q4_K_S GGUF UNet + fp8 text encoder + 2 AnyPose LoRAs fit 24 GB
const TIMEOUT_SEC          = 5400;
const PROVISION_TIMEOUT_MS = 2400000;    // ~40 min; ~24 GB model download (GGUF UNet + CLIP + 3 LoRAs + VAE)
const RENDER_TIMEOUT_MS    = 2700000;    // ~45 min; the first render may still be loading the models
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
const FIXTURE_DIR      = _path.join(WORK_DIR, 'workflows', WF_NAME);
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


function _isPng(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
}
function _isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
}
function _hexHead(b: Uint8Array, n = 8): string {
  return Array.from(b.slice(0, n)).map(x => x.toString(16).padStart(2, '0')).join(' ');
}

// ── Test execution ────────────────────────────────────────────────────────────
interface Scenario { id: string; prompt?: string; }

const ANYPOSE = "Make the person in image 1 do the exact same pose of the person in image 2. Changing the style and background of the image of the person in image 1 is undesirable, so don't do it. The new pose should be pixel accurate to the pose we are trying to copy. The position of the arms and head and legs should be the same as the pose we are trying to copy.";
const SCENARIOS: Scenario[] = [
  { id: 'default_prompt' },  // prompt_positive omitted: the YAML default (ANYPOSE) applies
  { id: 'keep_outfit_prompt', prompt: ANYPOSE + ' Keep her face, hair, olive t-shirt and grey shorts from image 1.' },
];

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
  const inputOf = (n: string) => manifest.inputs?.find((i: any) => i.name === n);
  const paramOf = (n: string) => manifest.params?.find((p: any) => p.name === n);
  check('manifest id matches', manifest.id === WF_NAME, manifest.id ?? '(null)');
  check('has primary output', manifest.outputs?.some((o: any) => o.role === 'primary'), JSON.stringify(manifest.outputs));
  check('has numeric seed param', paramOf('seed')?.seed === true && paramOf('seed')?.kind === 'int', JSON.stringify(paramOf('seed')));
  check('capabilities = [pose-transfer]', JSON.stringify(manifest.capabilities) === '["pose-transfer"]', JSON.stringify(manifest.capabilities));
  check('content marker is sfw', (manifest.content ?? 'sfw') === 'sfw', String(manifest.content));
  check('subject_image is the required subject', inputOf('subject_image')?.required === true && inputOf('subject_image')?.referenceRole === 'subject', JSON.stringify(inputOf('subject_image')));
  check('pose_image is a required reference', inputOf('pose_image')?.required === true && inputOf('pose_image')?.referenceRole === 'reference', JSON.stringify(inputOf('pose_image')));
  check('prompt_positive has the AnyPose default', String(paramOf('prompt_positive')?.default ?? '').includes('exact same pose'), JSON.stringify(paramOf('prompt_positive')?.default));

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
  const subjectUrl = await ensureFixture(`${S3_FIXTURE_PREFIX}/fixture_subject.png`, _path.join(FIXTURE_DIR, 'fixture_subject.png'));
  const poseUrl = await ensureFixture(`${S3_FIXTURE_PREFIX}/fixture_pose_reference.png`, _path.join(FIXTURE_DIR, 'fixture_pose_reference.png'));
  const subjectBytes = _nodeFs.readFileSync(_path.join(FIXTURE_DIR, 'fixture_subject.png')) as Uint8Array;

  // 4. One render per scenario ─────────────────────────────────────────────────
  const only = (process.env.SCENARIO_IDS ?? '').split(',').filter(Boolean);
  for (const sc of SCENARIOS.filter(s => only.length === 0 || only.includes(s.id))) {
    console.log(`\n── 4. Render: ${sc.id} ─────────────────────────────────────────`);
    const params: Record<string, unknown> = { steps: 8, seed: 4242 };
    if (sc.prompt) params.prompt_positive = sc.prompt;
    const renderId = await agent.run(
      JSON.stringify(RENDER_PROFILE),
      JSON.stringify({ subject_image: subjectUrl, pose_image: poseUrl }),
      JSON.stringify(params),
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
      check(`${sc.id}: output is PNG or JPEG`, _isPng(raw) || _isJpeg(raw), `magic=${_hexHead(raw)}`);
      check(`${sc.id}: output differs from the subject (the pose changed)`, raw.length !== subjectBytes.length || _hexHead(raw, 64) !== _hexHead(subjectBytes, 64), `${raw.length} vs ${subjectBytes.length} bytes`);
    }
  }

  console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED ✓' : failures.length + ' CHECK(S) FAILED ✗'} ===`);
  if (failures.length > 0) for (const f of failures) console.log(`  ✗ ${f}`);

} finally {
  await teardownAll();
  if (failures.length > 0) throw new Error(`${failures.length} e2e check(s) failed:\n${failures.join('\n')}`);
}
