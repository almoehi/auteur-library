/**
 * WorkflowAgent E2E — krea2_character_sheet
 *
 * Run inside the harness container (standard fat-image deployment):
 *   docker exec -it harness golem repl \
 *     --script-file /work/workflows/krea2_character_sheet/e2e-test.ts --yes
 *
 * Dev-tree fallback (local golem server, not via fat image):
 *   WORK_DIR=/path/to/repo-root \
 *   source video-harness/.env && cd video-harness && \
 *   golem repl --script-file ../workflows/krea2_character_sheet/e2e-test.ts --yes
 *
 * All models have public download URLs — no manual setup required.
 */

// ── CONFIG ───────────────────────────────────────────────────────────────────
const WF_NAME              = "krea2_character_sheet";
const GPU_TYPE             = "l40s";           // 48 GB VRAM — H3 32B CLIP requires 48 GB minimum
const TIMEOUT_SEC          = 1800;
const PROVISION_TIMEOUT_MS = 5400000;          // 90 min — ~60 GB model download
const RENDER_TIMEOUT_MS    = 1800000;          // 30 min — Krea2 8-step + H3 4-step turbo
const RENDER_POLL_MS       = 30_000;

const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND ?? 'modal';
const HF_TOKEN        = process.env.HF_TOKEN        ?? '';

// ── FIXTURE FILES ─────────────────────────────────────────────────────────────
const _path = require('node:path') as typeof import('node:path');
const WORK_DIR    = process.env.WORK_DIR ?? '/work';
const FIXTURE_DIR = _path.join(WORK_DIR, 'workflows', WF_NAME);

// Models are sourced from workflow.yaml via agent.loadFromContent() — no hardcoded WF_MODELS needed.

// ── Render profile ────────────────────────────────────────────────────────────
const RENDER_PROFILE = {
  tier: 'standard',
  profile: {
    compute: { backend: COMPUTE_BACKEND, gpuType: GPU_TYPE, timeoutSec: TIMEOUT_SEC, maxAttempts: 2 },
  },
};

const _nodeFs = require('node:fs') as typeof import('node:fs');

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
const agent = await (globalThis as any).WorkflowAgent.get(WF_NAME, `e2e-${WF_NAME}-${Date.now()}`);

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
  // model_family, portSpec, models, customNodes etc. are all parsed from the YAML by the downloader.
  const slimManifestJson = await agent.loadFromContent(WF_NAME, workflowJson, workflowYaml);
  const manifest = JSON.parse(slimManifestJson);
  if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
  console.log(`  Loaded: inputs=${manifest.inputs?.length ?? 0} outputs=${manifest.outputs?.length ?? 0}`);
  check('manifest id matches', manifest.id === WF_NAME, manifest.id ?? '(null)');
  check('has primary output', manifest.outputs?.some((o: any) => o.role === 'primary'), JSON.stringify(manifest.outputs));

  // 1b. Pre-flight: verify model URLs from YAML ─────────────────────────────────
  // Parse YAML to extract model URLs for reachability check (authoritative source of URLs).
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
  const promptCharacterText = _nodeFs.readFileSync(
    _path.join(FIXTURE_DIR, 'prompt_character.txt'), 'utf-8'
  ).toString().trim();

  // 4. Submit render ─────────────────────────────────────────────────────────
  console.log('\n── 4. Submit render ─────────────────────────────────────────────');
  const renderId = await agent.run(
    JSON.stringify(RENDER_PROFILE),
    JSON.stringify({}),
    JSON.stringify({
      prompt_character: promptCharacterText,
      width: 1920,
      height: 1080,
      steps: 8,
      frames: 124,
      fps: 24,
      seed: 42,
    }),
    undefined,
  );
  console.log(`  renderId=${renderId}`);
  check('renderId non-empty', renderId.length > 0, renderId);

  // 5. Poll to completion ────────────────────────────────────────────────────
  console.log('\n── 5. Poll to completion ────────────────────────────────────────');
  const result = await pollUntilDone(agent, renderId);
  check('render succeeded', result.phase === 'succeeded', `phase=${result.phase}`);

  // 6. Verify outputs — magic bytes, not content-type or filename extension ────
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
  function _hexHead(b: Uint8Array, n = 8): string {
    return Array.from(b.slice(0, n)).map(x => x.toString(16).padStart(2, '0')).join(' ');
  }

  if (result.phase === 'succeeded' && result.outputs?.length > 0) {
    console.log('\n── 6. Verify outputs ────────────────────────────────────────────');
    for (const out of result.outputs) {
      console.log(`  ${out.filename ?? 'output'}: ${out.url}`);
      const r = await fetch(out.url);
      check(`${out.name ?? out.filename} accessible`, r.ok, `HTTP ${r.status}`);
      const raw = new Uint8Array(await r.arrayBuffer());
      const hex = _hexHead(raw);
      if (out.kind === 'video') {
        check(`${out.name ?? out.filename} is MP4`, _isMp4(raw), `magic=${hex}`);
      } else if (out.kind === 'audio') {
        check(`${out.name ?? out.filename} is MP3`, _isMp3(raw), `magic=${hex}`);
      } else if (out.kind === 'image') {
        check(`${out.name ?? out.filename} is image`, _isPng(raw), `magic=${hex}`);
      }
    }
  } else {
    check('outputs present', (result.outputs?.length ?? 0) > 0, JSON.stringify(result.outputs));
  }

  console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED ✓' : failures.length + ' CHECK(S) FAILED ✗'} ===`);
  if (failures.length > 0) for (const f of failures) console.log(`  ✗ ${f}`);

} finally {
  await teardownAll();
  if (failures.length > 0) throw new Error(`${failures.length} e2e check(s) failed:\n${failures.join('\n')}`);
}
