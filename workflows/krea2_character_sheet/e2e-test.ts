// Deliberate copy: derived from ../krea2_character_sheet_nsfw/e2e-test.ts (the bundle is generated from the NSFW one by
// its build_workflow.py --variant sfw); kept a standalone file so each bundle's REPL test runs on its own. Keep in sync.
/**
 * WorkflowAgent E2E — krea2_character_sheet
 *
 * Two 15-panel clothed character-sheet renders on ONE provisioned a100 endpoint, submitted together so they
 * run concurrently (E2E_ONLY=A|B runs just one of them):
 *   A. female fixture (character_image.png),      gender=female, white_background=false (grey), seed 3003
 *   B. male fixture   (character_image_male.png), gender=other,  white_background=true  (white), seed 3003
 * (other = the male pose set with gender-neutral they/their prompt wording, like male)
 * Plus manifest checks (ports / params / outputs). For each render: phase succeeded, all 5 declared
 * outputs returned and PNG, character_sheet is 6464x2176, view_1 is 768x1920, portrait is 1216x1024. The sheets are saved next
 * to this script as out_female_grey.png / out_other_white.png for visual review.
 *
 * The pose templates are bundle assets resolved against BUNDLE_JSON_URL: push the bundle first and set
 * E2E_BUNDLE_REF=<branch or commit> to test an unmerged change (default main). Needs a harness build with
 * WorkflowAgent.loadFromContentAt (workflow.yaml assets support).
 *
 * Cost: REAL GPU + S3 (fixtures are staged in S3). Teardown runs in `finally`; still verify no orphaned
 * provider resources afterwards (root CLAUDE.md "cloud resources"). Needs S3_BUCKET / AWS_ACCESS_KEY /
 * AWS_SECRET_KEY (+ AWS_REGION); COMPUTE_BACKEND defaults to modal.
 *
 * Run inside the harness container (fat image; `/tmp/deploy-app.env` holds the deployed golem env name):
 *   docker exec -it harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/krea2_character_sheet/e2e-test.ts --yes'
 *
 * Dev-tree fallback (local golem server; fork golem binary):
 *   cd video-harness && source .env && export WORK_DIR="$(cd .. && pwd)" && \
 *     golem -L repl --script-file ../workflows/krea2_character_sheet/e2e-test.ts --yes
 */

// ── CONFIG ────────────────────────────────────────────────────────────────────
const WF_NAME              = "krea2_character_sheet";
const GPU_TYPE             = "h100";
const TIMEOUT_SEC          = 5400;
const PROVISION_TIMEOUT_MS = 5400000;          // 90 min — large model download
const RENDER_TIMEOUT_MS    = 2700000;          // 45 min per render — 15 panels sampled sequentially
const RENDER_POLL_MS       = 30_000;

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
// The pose templates are bundle assets: they resolve against the bundle's workflow.json in a PUSHED ref of the
// library repo (public raw URLs), exactly as in production. E2E_BUNDLE_REF picks the branch / commit (default main).
const BUNDLE_REF        = process.env.E2E_BUNDLE_REF ?? 'main';
const BUNDLE_JSON_URL   = `https://raw.githubusercontent.com/almoehi/auteur-library/${BUNDLE_REF}/workflows/${WF_NAME}/workflow.json`;

const SHEET_WIDTH   = 6464;
const SHEET_HEIGHT  = 2176;
const VIEW_WIDTH    = 768;
const VIEW_HEIGHT   = 1920;
const PORTRAIT_WIDTH  = 1216;
const PORTRAIT_HEIGHT = 1024;

type Gender = 'female' | 'male' | 'other';
interface Scenario {
  label: string;
  gender: Gender;
  whiteBackground: boolean;
  fixtureFile: string;
  outFile: string;
  seed: number;
}
const ALL_SCENARIOS: Scenario[] = [
  { label: 'A female/grey',  gender: 'female', whiteBackground: false, fixtureFile: 'character_image.png',      outFile: 'out_female_grey.png', seed: 3003 },
  { label: 'B other/white',  gender: 'other',  whiteBackground: true,  fixtureFile: 'character_image_male.png', outFile: 'out_other_white.png', seed: 3003 },
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

/** Every declared output present (by nodeId, else `<port>.<ext>` stem), downloaded, PNG. Returns bytes by port. */
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
    check(`${label}: ${port.name} is PNG`, _isPng(raw), `${raw.length} bytes`);
  }
  return bytes;
}

function checkSize(label: string, port: string, bytes: Record<string, Uint8Array>, width: number, height: number): void {
  const b = bytes[port];
  if (!b || !_isPng(b)) { check(`${label}: ${port} is ${width}x${height}`, false, 'missing or not a PNG'); return; }
  const s = _pngSize(b);
  check(`${label}: ${port} is ${width}x${height}`, s.width === width && s.height === height, `${s.width}x${s.height}`);
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

  // 1. Load bundle + manifest checks ───────────────────────────────────────────
  console.log('── 1. Load workflow from bundle ─────────────────────────────');
  const workflowJson = _nodeFs.readFileSync(_path.join(FIXTURE_DIR, 'workflow.json'), 'utf8') as string;
  const workflowYaml = _nodeFs.readFileSync(_path.join(FIXTURE_DIR, 'workflow.yaml'), 'utf8') as string;
  const manifest = JSON.parse(await agent.loadFromContentAt(WF_NAME, workflowJson, workflowYaml, BUNDLE_JSON_URL));
  if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
  check('manifest id matches', manifest.id === WF_NAME, manifest.id ?? '(null)');
  check('workflow_type is i2i', manifest.workflowType === 'i2i' || manifest.workflow_type === 'i2i',
    String(manifest.workflowType ?? manifest.workflow_type));
  check('model_family is krea2', (manifest.modelFamily ?? manifest.model_family) === 'krea2',
    String(manifest.modelFamily ?? manifest.model_family));

  const charInput = manifest.inputs?.find((i: any) => i.name === 'character_image');
  check('character_image is a required image input', charInput?.kind === 'image' && charInput?.required === true, JSON.stringify(charInput));

  const paramByName = (n: string): any => manifest.params?.find((p: any) => p.name === n);
  const genderParam = paramByName('gender');
  const genderEnum: string[] = genderParam?.constraints?.enum ?? genderParam?.enum ?? [];
  check('gender is enum female|male|other', genderParam?.kind === 'enum' && ['female', 'male', 'other'].every(g => genderEnum.includes(g)), JSON.stringify(genderParam));
  check('character_image is the subject reference', (charInput?.referenceRole ?? charInput?.reference_role) === 'subject', JSON.stringify(charInput));
  check('white_background is bool', paramByName('white_background')?.kind === 'bool', JSON.stringify(paramByName('white_background')));
  check('identity_prompt is declared', !!paramByName('identity_prompt'), JSON.stringify(paramByName('identity_prompt')));
  check('seed is a numeric seed param', paramByName('seed')?.seed === true && paramByName('seed')?.kind === 'int', JSON.stringify(paramByName('seed')));
  for (const n of ['steps', 'identity_strength']) check(`param ${n} is declared`, !!paramByName(n), JSON.stringify(paramByName(n)));
  check('no nsfw_strength param', !paramByName('nsfw_strength'), JSON.stringify(paramByName('nsfw_strength')));

  const outputNames: string[] = (manifest.outputs ?? []).map((o: any) => o.name);
  const wantedOutputs = ['character_sheet', 'view_1', 'view_2', 'view_3', 'portrait'];
  check('declares exactly the 5 outputs', wantedOutputs.every(n => outputNames.includes(n)) && outputNames.length === wantedOutputs.length, JSON.stringify(outputNames));
  const sheetOut = manifest.outputs?.find((o: any) => o.name === 'character_sheet');
  check('character_sheet is the primary output', sheetOut?.role === 'primary', JSON.stringify(sheetOut));

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

  // 3. Stage fixtures, submit both renders together ────────────────────────────
  console.log('\n── 3. Stage fixtures + submit both renders ──────────────────────');
  const renderIds: string[] = [];
  for (const sc of SCENARIOS) {
    const url = await ensureFixture(`${S3_FIXTURE_PREFIX}/${sc.fixtureFile}`, _path.join(FIXTURE_DIR, sc.fixtureFile));
    const id: string = await agent.run(
      JSON.stringify(RENDER_PROFILE),
      JSON.stringify({ character_image: url }),
      JSON.stringify({ gender: sc.gender, white_background: sc.whiteBackground, seed: sc.seed }),
      undefined,  // promiseId
      undefined,  // promiseTimeoutMs
      undefined,  // loraJson
      undefined,  // notifyJson
    );
    console.log(`  [${sc.label}] renderId=${id}`);
    check(`${sc.label}: renderId non-empty`, id.length > 0, id);
    renderIds.push(id);
  }
  check('render ids differ', new Set(renderIds).size === renderIds.length, renderIds.join(' vs '));

  // 4. Poll both concurrently, then verify ─────────────────────────────────────
  console.log('\n── 4. Poll renders (concurrent) ─────────────────────────────────');
  const outcomes = await Promise.all(SCENARIOS.map((sc, i) => pollUntilDone(agent, sc.label, renderIds[i])));

  console.log('\n── 5. Verify outputs ────────────────────────────────────────────');
  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];
    const outcome = outcomes[i];
    check(`${sc.label}: render succeeded`, outcome.ok, outcome.ok ? 'succeeded' : outcome.error);
    if (!outcome.ok) continue;
    const bytes = await verifyOutputs(sc.label, outcome.result, manifest);
    checkSize(sc.label, 'character_sheet', bytes, SHEET_WIDTH, SHEET_HEIGHT);
    checkSize(sc.label, 'view_1', bytes, VIEW_WIDTH, VIEW_HEIGHT);
    checkSize(sc.label, 'portrait', bytes, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
    if (bytes['character_sheet']) {
      const outPath = _path.join(FIXTURE_DIR, sc.outFile);
      _nodeFs.writeFileSync(outPath, bytes['character_sheet']);
      console.log(`  [${sc.label}] sheet saved for visual review: ${outPath}`);
    }
  }

  console.log(`\n=== ${failures.length === 0 ? 'PASS — ALL CHECKS PASSED ✓' : 'FAIL — ' + failures.length + ' CHECK(S) FAILED ✗'} ===`);
  for (const f of failures) console.log(`  ✗ ${f}`);

} finally {
  await teardownAll();
  if (failures.length > 0) throw new Error(`${failures.length} e2e check(s) failed:\n${failures.join('\n')}`);
}
