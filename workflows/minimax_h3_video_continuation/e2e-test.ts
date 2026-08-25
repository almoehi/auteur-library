/**
 * WorkflowAgent E2E — minimax_h3_video_continuation
 *
 * Run inside the harness container (standard fat-image deployment):
 *   docker exec -it harness golem repl \
 *     --script-file /work/workflows/minimax_h3_video_continuation/e2e-test.ts --yes
 *
 * Dev-tree fallback (local golem server, not via fat image):
 *   WORK_DIR=/path/to/repo-root \
 *   source video-harness/.env && cd video-harness && \
 *   golem repl --script-file ../workflows/minimax_h3_video_continuation/e2e-test.ts --yes
 */

// ── CONFIG ───────────────────────────────────────────────────────────────────
const WF_NAME = "minimax_h3_video_continuation";
const GPU_TYPE = "a100"; // minimum GPU from gpu_types allowlist (≥40 GB VRAM)
const TIMEOUT_SEC = 7200; // 2-hour GPU timeout
const PROVISION_TIMEOUT_MS = 3600000; // 60 min — 60 GB model download on first run
const RENDER_TIMEOUT_MS = 1800000; // 30 min per clip at steps=20
const RENDER_POLL_MS = 30_000;

const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND ?? "modal";
const S3_BUCKET = process.env.S3_BUCKET ?? "";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY ?? "";
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY ?? "";
const HF_TOKEN = process.env.HF_TOKEN ?? "";

const missing = [
  ["S3_BUCKET", S3_BUCKET],
  ["AWS_ACCESS_KEY", AWS_ACCESS_KEY],
  ["AWS_SECRET_KEY", AWS_SECRET_KEY],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length)
  throw new Error(`Missing required env vars: ${missing.join(", ")}`);

// ── FIXTURE FILES — colocated with this script in workflows/<name>/ ───────────
const _path = require("node:path") as typeof import("node:path");
const WORK_DIR = process.env.WORK_DIR ?? "/work";
const FIXTURE_DIR = _path.join(WORK_DIR, "workflows", WF_NAME);
const S3_FIXTURE_PREFIX = `e2e-fixtures/${WF_NAME}`;

// Models are sourced from workflow.yaml via agent.loadFromContent() — no hardcoded WF_MODELS needed.

// ── Render profile ────────────────────────────────────────────────────────────
const RENDER_PROFILE = {
  tier: "standard",
  profile: {
    compute: {
      backend: COMPUTE_BACKEND,
      gpuType: GPU_TYPE,
      timeoutSec: TIMEOUT_SEC,
      maxAttempts: 2,
    },
  },
};

// ── S3 fixture helper ─────────────────────────────────────────────────────────
const _crypto = require("node:crypto") as typeof import("node:crypto");
const _https = require("node:https") as typeof import("node:https");
const _nodeFs = require("node:fs") as typeof import("node:fs");

function _s3PresignGet(key: string, expiresIn = 14400): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const day = ts.slice(0, 8);
  const host = `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;
  const scope = `${day}/${AWS_REGION}/s3/aws4_request`;
  const credEnc = encodeURIComponent(`${AWS_ACCESS_KEY}/${scope}`);
  const canonQuery = [
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${credEnc}`,
    `X-Amz-Date=${ts}`,
    `X-Amz-Expires=${expiresIn}`,
    `X-Amz-SignedHeaders=host`,
  ].join("&");
  const canonReq = [
    "GET",
    "/" + key,
    canonQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const sts = [
    "AWS4-HMAC-SHA256",
    ts,
    scope,
    _crypto.createHash("sha256").update(canonReq).digest("hex"),
  ].join("\n");
  const hmac = (k: Buffer | string, d: string) =>
    _crypto.createHmac("sha256", k).update(d).digest();
  const sigKey = hmac(
    hmac(hmac(hmac(`AWS4${AWS_SECRET_KEY}`, day), AWS_REGION), "s3"),
    "aws4_request",
  );
  const sig = _crypto.createHmac("sha256", sigKey).update(sts).digest("hex");
  return `https://${host}/${key}?${canonQuery}&X-Amz-Signature=${sig}`;
}

function _s3Headers(
  method: string,
  key: string,
  body: Buffer,
  contentType?: string,
): Record<string, string> {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const day = ts.slice(0, 8);
  const host = `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;
  const hash = _crypto.createHash("sha256").update(body).digest("hex");
  const pairs: [string, string][] = [
    ["host", host],
    ["x-amz-content-sha256", hash],
    ["x-amz-date", ts],
  ];
  if (contentType) pairs.push(["content-type", contentType]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const signedHdrs = pairs.map(([k]) => k).join(";");
  const canonHdrs = pairs.map(([k, v]) => `${k}:${v}`).join("\n") + "\n";
  const canonReq = [method, "/" + key, "", canonHdrs, signedHdrs, hash].join(
    "\n",
  );
  const scope = `${day}/${AWS_REGION}/s3/aws4_request`;
  const sts = [
    "AWS4-HMAC-SHA256",
    ts,
    scope,
    _crypto.createHash("sha256").update(canonReq).digest("hex"),
  ].join("\n");
  const hmac = (k: Buffer | string, d: string) =>
    _crypto.createHmac("sha256", k).update(d).digest();
  const sigKey = hmac(
    hmac(hmac(hmac(`AWS4${AWS_SECRET_KEY}`, day), AWS_REGION), "s3"),
    "aws4_request",
  );
  const sig = _crypto.createHmac("sha256", sigKey).update(sts).digest("hex");
  return {
    ...Object.fromEntries(pairs),
    authorization: `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY}/${scope}, SignedHeaders=${signedHdrs}, Signature=${sig}`,
  };
}

function _s3Req(
  method: string,
  key: string,
  body: Buffer,
  contentType?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const hdrs: Record<string, string | number> = _s3Headers(
      method,
      key,
      body,
      contentType,
    );
    if (body.length) hdrs["content-length"] = body.length;
    const req = _https.request(
      {
        hostname: `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`,
        path: "/" + key,
        method,
        headers: hdrs,
      },
      (res: any) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

async function ensureFixture(
  s3Key: string,
  localPath: string,
  contentType = "image/png",
): Promise<string> {
  if ((await _s3Req("HEAD", s3Key, Buffer.alloc(0))) !== 200) {
    const data = _nodeFs.readFileSync(localPath) as Buffer;
    const status = await _s3Req("PUT", s3Key, data, contentType);
    if (status !== 200)
      throw new Error(`S3 PUT failed for ${s3Key}: HTTP ${status}`);
    console.log(`  [upload] ${s3Key} (${data.length} bytes)`);
  } else {
    console.log(`  [skip]   ${s3Key}`);
  }
  return _s3PresignGet(s3Key);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const failures: string[] = [];

function check(name: string, cond: boolean, detail: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${name} — ${detail}`);
  if (!cond) failures.push(`${name}: ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntilDone(agent: any, renderId: string): Promise<any> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const json = await agent.runStatus(renderId);
    const result = JSON.parse(json ?? "null");
    if (!result)
      throw new Error(`runStatus returned null for renderId "${renderId}"`);
    if (result.phase !== lastPhase) {
      console.log(
        `    phase=${result.phase}  attempts=${result.attempts ?? 0}`,
      );
      lastPhase = result.phase;
    }
    if (result.phase === "succeeded") return result;
    if (result.phase === "failed") {
      const f = result.failure ?? {};
      throw new Error(
        `render failed: kind=${f.kind ?? "?"} — ${f.message ?? "(no message)"}`,
      );
    }
    await sleep(RENDER_POLL_MS);
  }
  throw new Error(`render timed out after ${RENDER_TIMEOUT_MS / 1000}s`);
}

// ── Agent ─────────────────────────────────────────────────────────────────────
const agent = await (globalThis as any).WorkflowAgent.get(
  WF_NAME,
  `e2e-${WF_NAME}-${Date.now()}`,
);

async function teardownAll(): Promise<void> {
  console.log(
    "\n── Teardown ─────────────────────────────────────────────────────",
  );
  try {
    await agent.teardown();
    console.log("  ✓ teardown() completed");
    const st = JSON.parse(await agent.backendStatus());
    check(
      "status after teardown is not provisioned",
      st.status !== "provisioned",
      st.status,
    );
  } catch (err) {
    console.log(`  ✗ teardown() threw: ${err}`);
    failures.push(`teardown: ${err}`);
  }
}

// ── Prompt fixture ────────────────────────────────────────────────────────────
// Minimal REF2V continuation prompt for e2e validation.
const E2E_PROMPT = `How the reference video and pictures align with the target video — <Video 1> supplies the frames immediately preceding the target video; the target video resumes from its final frame at the 0.00-second mark with no cut. Target duration 6.00 seconds.

summary:
[video continuation + reference generation] The target video continues <Video 1> without interruption, carrying the subject's motion through a continuous scene.

subject_definitions:
<Video 1> establishes the inherited motion, camera position, framing, and lighting at the seam; the target video continues that trajectory and light without a cut.
<Subject 1> is the person defined by <Picture 1>. Her identity follows <Picture 1>; her position and lighting follow <Video 1>.
<Subject 2> is the environment from <Picture 2>. The room follows <Picture 2> in layout and light; camera position follows the action.

integrated_multimodal_description: [Shot 1] Live-action, cinematic interior light. The shot resumes from the final frame of <Video 1> with no cut, continuing the subject's motion seamlessly. The camera holds a medium shot, tracking the subject as she moves through the space. The framing stays consistent and the lighting remains unchanged throughout.

overall_soundscape: The low room tone from the preceding shot continues unbroken beneath subtle ambient sounds.

non_diegetic_music: N/A`;

// ── Test execution ────────────────────────────────────────────────────────────
try {
  console.log(`=== WorkflowAgent E2E — ${WF_NAME} ===\n`);

  // 1. Load workflow from bundle ─────────────────────────────────────────────
  console.log("── 1. Load workflow from bundle ─────────────────────────────");
  const _fs: {
    readFileSync: (p: string, enc: string) => string;
  } = require("node:fs");
  const workflowJson = _fs.readFileSync(
    _path.join(FIXTURE_DIR, "workflow.json"),
    "utf8",
  );
  const workflowYaml = _fs.readFileSync(
    _path.join(FIXTURE_DIR, "workflow.yaml"),
    "utf8",
  );
  check(
    "workflow.json loaded",
    workflowJson.length > 0,
    `${workflowJson.length} bytes`,
  );
  check(
    "workflow.yaml loaded",
    workflowYaml.length > 0,
    `${workflowYaml.length} bytes`,
  );

  // Routes through WorkflowDownloader.buildEntryFromContent() — same path as production workspace.
  const slimManifestJson = await agent.loadFromContent(WF_NAME, workflowJson, workflowYaml);
  const manifest = JSON.parse(slimManifestJson);
  if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
  console.log(
    `  Loaded: inputs=${manifest.inputs?.length ?? 0} outputs=${manifest.outputs?.length ?? 0}`,
  );
  check("manifest id matches", manifest.id === WF_NAME, manifest.id ?? "(null)");
  check(
    "has prior_clip input",
    manifest.inputs?.some((i: any) => i.name === "prior_clip"),
    JSON.stringify(manifest.inputs?.map((i: any) => i.name)),
  );
  check(
    "has character_sheet input",
    manifest.inputs?.some((i: any) => i.name === "character_sheet"),
    JSON.stringify(manifest.inputs?.map((i: any) => i.name)),
  );
  check(
    "has environment_plate input",
    manifest.inputs?.some((i: any) => i.name === "environment_plate"),
    JSON.stringify(manifest.inputs?.map((i: any) => i.name)),
  );
  check(
    "has ref_picture_3 input (optional)",
    manifest.inputs?.some((i: any) => i.name === "ref_picture_3"),
    JSON.stringify(manifest.inputs?.map((i: any) => i.name)),
  );
  check(
    "has prompt_positive param",
    manifest.params?.some((p: any) => p.name === "prompt_positive"),
    JSON.stringify(manifest.params?.map((p: any) => p.name)),
  );
  check(
    "has primary output",
    manifest.outputs?.some((o: any) => o.role === "primary"),
    JSON.stringify(manifest.outputs),
  );

  // 1b. Pre-flight: verify model URLs from YAML ─────────────────────────────────
  console.log(
    "\n── 1b. Pre-flight: verify model URLs ────────────────────────────",
  );
  const _yaml: { parse: (input: string) => any } = require("yaml");
  const parsedYaml = _yaml.parse(workflowYaml);
  for (const model of (parsedYaml.models ?? [])) {
    for (const f of (model.files ?? [])) {
      const url = f.url as string;
      if (!url) { console.log(`  [skip] ${model.name} — no public URL`); continue; }
      const headers: Record<string, string> = {};
      if (url.includes("huggingface.co") && HF_TOKEN)
        headers["Authorization"] = `Bearer ${HF_TOKEN}`;
      const resp = await fetch(url, { method: "HEAD", redirect: "follow", headers });
      check(
        `${model.name} URL resolves`,
        resp.ok,
        `HTTP ${resp.status} — ${url.slice(0, 80)}`,
      );
    }
  }
  if (failures.length > 0)
    throw new Error(`Model URL pre-flight failed:\n${failures.join("\n")}`);

  // 2. Provision ───────────────────────────────────────────────────────────────
  console.log(
    "\n── 2. Provision " + GPU_TYPE + " endpoint ─────────────────────",
  );
  await agent.provision();
  const provDeadline = Date.now() + PROVISION_TIMEOUT_MS;
  let provSummary: any = null;
  while (Date.now() < provDeadline) {
    const st = JSON.parse(await agent.backendStatus());
    if (st.status === "provisioned") {
      provSummary = st;
      break;
    }
    if (st.status === "failed")
      throw new Error(`Provisioning failed: ${st.error}`);
    console.log(`  [${st.status}] dc=${st.dcIndex ?? 0}/${st.dcTotal ?? "?"}`);
    await sleep(25_000);
  }
  if (!provSummary)
    throw new Error(
      `Provision timed out after ${PROVISION_TIMEOUT_MS / 60_000} min`,
    );
  check(
    "provisioned",
    provSummary.status === "provisioned",
    provSummary.status,
  );

  // 3. Stage fixture files in S3 ──────────────────────────────────────────────
  console.log(
    "\n── 3. Stage fixture files in S3 ─────────────────────────────────",
  );
  const priorClipUrl = await ensureFixture(
    `${S3_FIXTURE_PREFIX}/prior_clip.mp4`,
    _path.join(FIXTURE_DIR, "prior_clip.mp4"),
    "video/mp4",
  );
  const charSheetUrl = await ensureFixture(
    `${S3_FIXTURE_PREFIX}/character_sheet.png`,
    _path.join(FIXTURE_DIR, "char_sheet.png"),
  );
  const scenePlateUrl = await ensureFixture(
    `${S3_FIXTURE_PREFIX}/environment_plate.png`,
    _path.join(FIXTURE_DIR, "scene_plate.png"),
  );
  const refPicture3Url = await ensureFixture(
    `${S3_FIXTURE_PREFIX}/ref_picture_3.png`,
    _path.join(FIXTURE_DIR, "ref_image_pose.png"),
  );

  // 4. Submit render ─────────────────────────────────────────────────────────
  console.log(
    "\n── 4. Submit render ─────────────────────────────────────────────",
  );
  const renderId = await agent.run(
    JSON.stringify(RENDER_PROFILE),
    JSON.stringify({
      prior_clip: priorClipUrl,
      character_sheet: charSheetUrl,
      environment_plate: scenePlateUrl,
      ref_picture_3: refPicture3Url,
      // ref_picture_4 and ref_picture_5 intentionally omitted to cover optional-port path
    }),
    JSON.stringify({
      prompt_positive: E2E_PROMPT,
      steps: 4, // fast draft
      fps: 24,
      duration_seconds: 6.0,
      prior_clip_start_time: 0.0,
    }),
    undefined,
  );
  console.log(`  renderId=${renderId}`);
  check("renderId non-empty", renderId.length > 0, renderId);

  // 5. Poll to completion ────────────────────────────────────────────────────
  console.log(
    "\n── 5. Poll to completion ────────────────────────────────────────",
  );
  const result = await pollUntilDone(agent, renderId);
  check(
    "render succeeded",
    result.phase === "succeeded",
    `phase=${result.phase}`,
  );

  // 6. Verify output ─────────────────────────────────────────────────────────
  if (result.phase === "succeeded" && result.outputs?.length > 0) {
    console.log(
      "\n── 6. Verify output ─────────────────────────────────────────────",
    );
    for (const out of result.outputs) {
      console.log(`  ${out.name ?? "output"}: ${out.url}`);
    }
    const outputUrl = result.outputs[0].url;
    const getResp = await fetch(outputUrl);
    check("output accessible", getResp.ok, `HTTP ${getResp.status}`);
    const ct = getResp.headers.get("content-type") ?? "";
    check("output is video", ct.startsWith("video/"), ct);
    await getResp.arrayBuffer();
  } else {
    check(
      "outputs present",
      (result.outputs?.length ?? 0) > 0,
      JSON.stringify(result.outputs),
    );
  }

  console.log(
    `\n=== ${failures.length === 0 ? "ALL CHECKS PASSED ✓" : failures.length + " CHECK(S) FAILED ✗"} ===`,
  );
  if (failures.length > 0) for (const f of failures) console.log(`  ✗ ${f}`);
} finally {
  await teardownAll();
  if (failures.length > 0)
    throw new Error(
      `${failures.length} e2e check(s) failed:\n${failures.join("\n")}`,
    );
}
