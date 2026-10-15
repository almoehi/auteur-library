/**
 * WorkflowAgent E2E — h3_single_cut_clip
 *
 * Covers the manifest contract (ref0 required and pinned as frame 0, ref1-ref5 optional, four
 * opt-in lora ports) and two renders that settle what only a real render can show:
 *   1. "one-ref" - ref0 alone (the mandatory start frame is enough).
 *   2. "refs"    - ref0 + ref1 + ref2.
 * Both check the output is a video of the requested width x height.
 *
 * NSFW bundles read their fixtures from the SFW sibling (workflows/h3_single_cut_clip).
 *
 * WorkflowAgent's RPC surface does not expose the bound ComfyUI prompt, so the appended slot
 * shape itself is covered by the harness unit tests (bindWorkflow()/appendLoraSlot()).
 *
 * Cost: REAL GPU (Modal/Beam/RunPod per COMPUTE_BACKEND, a100, two short renders + ~38 GB first-run model download) and S3.
 * The script tears the endpoint down in `finally`; still verify no orphaned provider resources
 * afterwards (root CLAUDE.md "cloud resources").
 *
 * Run inside the harness container (standard fat-image deployment; `/tmp/deploy-app.env` holds the
 * deployed golem env name, single quotes keep `$(cat ...)` inside the container):
 *   docker exec -it harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/h3_single_cut_clip/e2e-test.ts --yes'
 *
 * Dev-tree fallback (local golem server, not via fat image; fork golem binary):
 *   cd video-harness && source .env && export WORK_DIR="$(cd .. && pwd)" && \
 *     golem -L repl --script-file ../workflows/h3_single_cut_clip/e2e-test.ts --yes
 */

// ── CONFIG ───────────────────────────────────────────────────────────────────
// Deliberate copy: the SFW and the _nsfw e2e scripts are identical except WF_NAME (USE_LORA
// follows from it). `golem repl --script-file` runs one self-contained file and the fat image
// mounts only workflows/, so they cannot share a module - keep both copies in sync.
const WF_NAME = "h3_single_cut_clip";
const GPU_TYPE = "a100"; // 40 GB VRAM minimum; a100 is the smallest card in gpu_types
const TIMEOUT_SEC = 7200;
const PROVISION_TIMEOUT_MS = 60 * 60 * 1000; // ~38 GB models on first run
const RENDER_TIMEOUT_MS = 45 * 60 * 1000;
const RENDER_POLL_MS = 30_000;

const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND ?? "modal";
const S3_BUCKET = process.env.S3_BUCKET ?? "";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY ?? "";
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY ?? "";
const HF_TOKEN = process.env.HF_TOKEN ?? ""; // needed for gated HuggingFace models

const missing = [
  ["S3_BUCKET", S3_BUCKET],
  ["AWS_ACCESS_KEY", AWS_ACCESS_KEY],
  ["AWS_SECRET_KEY", AWS_SECRET_KEY],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length)
  throw new Error(`Missing required env vars: ${missing.join(", ")}`);

// ── FIXTURE FILES — colocated with this script in workflows/<name>/ ─────────
const _path = require("node:path") as typeof import("node:path");
// /work is the bind-mount of $PWD inside the harness container (run.sh mounts $PWD/workflows
// as /work/workflows). Override WORK_DIR for the dev-tree fallback.
const WORK_DIR = process.env.WORK_DIR ?? "/work";
const FIXTURE_DIR = _path.join(WORK_DIR, "workflows", WF_NAME);
// The NSFW bundle has no fixtures of its own: its prompt comes from the SFW sibling.
const SFW_NAME = WF_NAME.replace(/_nsfw$/, "");
const SHARED_FIXTURE_DIR = _path.join(WORK_DIR, "workflows", SFW_NAME);
// Media fixtures are shared with minimax_h3_video_continuation (no binary copies in this bundle).
const MEDIA_FIXTURE_DIR = _path.join(WORK_DIR, "workflows", "minimax_h3_video_continuation");
// Only the NSFW bundles exercise the per-call (NSFW catalog) lora download.
const USE_LORA = WF_NAME.endsWith("_nsfw");

// Models are sourced from workflow.yaml via agent.loadFromContent() — no hardcoded WF_MODELS needed.

// Own prefix per bundle (the fixtures are the SFW sibling's files).
const S3_FIXTURE_PREFIX = `e2e-fixtures/${WF_NAME}`;

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


// ── MP4 size probe ────────────────────────────────────────────────────────────
// Reads the first non-zero tkhd width/height (16.16 fixed point) of an mp4 buffer. Enough to
// compare sizes without ffprobe (the REPL host has none).
function mp4Size(buf: Buffer): { width: number; height: number } | null {
  let at = buf.indexOf("tkhd");
  while (at >= 0) {
    const version = buf[at + 4];
    const off = at + 4 + (version === 1 ? 92 : 76);
    if (off + 8 <= buf.length) {
      const width = buf.readUInt32BE(off) / 65536;
      const height = buf.readUInt32BE(off + 4) / 65536;
      if (width > 0 && height > 0) return { width, height };
    }
    at = buf.indexOf("tkhd", at + 4);
  }
  return null;
}

// Python-style round-half-even of x / 32, times 32 (what the workflow's size snap does).
function snap32(x: number): number {
  const q = x / 32;
  const f = Math.floor(q);
  const r = q - f;
  const n = r > 0.5 ? f + 1 : r < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return n * 32;
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

// Asserts the render billing record for `renderId` via the owning WorkspaceAgent's
// billingInfo() — the authoritative KV read (pollState().billing is all-zero for a workspace that
// was never open()ed, which the SCOPE workspace here never is).
// Latest render-attempt event for `renderId` (a retried render has one event per attempt;
// shared `kind: "download"` events are not render attempts).
function renderEvent<
  E extends { renderId: string; attempt: number; kind?: string },
>(events: E[], renderId: string): E | undefined {
  return events
    .filter((e) => e.renderId === renderId && e.kind !== "download")
    .sort((a, b) => b.attempt - a.attempt)[0];
}

async function checkBillingAfterRender(
  label: string,
  renderId: string,
  expectedOutcome: "success" | "failed",
): Promise<void> {
  // wasi:keyvalue/eventual is eventually consistent — a read right after renderBillingEnd()'s
  // write (from WorkflowAgent) can briefly miss it. Retry a few times.
  let info = await wsAgent.billingInfo();
  let event = renderEvent(info.events, renderId);
  for (let attempt = 0; attempt < 5 && !event?.outcome; attempt++) {
    await sleep(1_000);
    info = await wsAgent.billingInfo();
    event = renderEvent(info.events, renderId);
  }
  const summary = info.summary;
  check(
    `${label}: billing total count >= 1`,
    summary.successCount + summary.failedCount + summary.pendingCount >= 1,
    `success=${summary.successCount} failed=${summary.failedCount} pending=${summary.pendingCount}`,
  );
  // Mirrors summarizeBilling() (video-harness/src/render/billing.ts): the shared download-job
  // buckets count into totalCents. Duplicated from video-harness/e2e/lib/workflow-e2e.cjs on
  // purpose — this script also runs in the fat image, where only workflows/ is mounted.
  const bucketCents = [
    summary.successCents,
    summary.failedCents,
    summary.pendingCents,
    summary.downloadSuccessCents,
    summary.downloadFailedCents,
  ];
  const bucketSum = bucketCents.reduce((a, b) => a + b, 0);
  check(
    `${label}: totalCents equals sum of bucket cents`,
    summary.totalCents === bucketSum,
    `totalCents=${summary.totalCents} sum=${bucketSum} buckets=${JSON.stringify(bucketCents)}`,
  );
  check(
    `${label}: all cents amounts non-negative`,
    bucketCents.every((c) => c >= 0),
    `buckets=${JSON.stringify(bucketCents)}`,
  );
  check(
    `${label}: billing event recorded for this renderId`,
    !!event,
    JSON.stringify(event ?? null),
  );
  if (!event) return;
  check(
    `${label}: event providerKey is ${COMPUTE_BACKEND}`,
    event.providerKey === COMPUTE_BACKEND,
    String(event.providerKey),
  );
  check(
    `${label}: event gpuType is ${GPU_TYPE}`,
    event.gpuType === GPU_TYPE,
    String(event.gpuType),
  );
  check(
    `${label}: event wfName matches`,
    event.wfName === WF_NAME,
    String(event.wfName),
  );
  check(
    `${label}: event outcome is ${expectedOutcome}`,
    event.outcome === expectedOutcome,
    String(event.outcome),
  );
  check(
    `${label}: event has dispatchedAt`,
    !!event.dispatchedAt,
    String(event.dispatchedAt),
  );
  check(
    `${label}: event has a completion timestamp (handler or poll-observed)`,
    !!(event.handlerCompletedAt || event.pollObservedCompletedAt),
    `handlerCompletedAt=${event.handlerCompletedAt} pollObservedCompletedAt=${event.pollObservedCompletedAt}`,
  );
}

// ── Agent ─────────────────────────────────────────────────────────────────────
// SCOPE doubles as the owning WorkspaceAgent id (billing is keyed by it), so it must satisfy the
// workspace id format "<name>@<version>" — the constructor only parses it, no spec is needed.
const SCOPE = `e2e-${WF_NAME}@${Date.now()}`;
const agent = await WorkflowAgent.get(WF_NAME, SCOPE);
const wsAgent = await WorkspaceAgent.get(SCOPE);

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

// ── Test execution ────────────────────────────────────────────────────────────
try {
  console.log(`=== WorkflowAgent E2E — ${WF_NAME} ===\n`);

  // 1. Load workflow from bundle ─────────────────────────────────────────────
  console.log(
    "── 1. Load workflow from bundle ─────────────────────────────────",
  );
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
  // model_family, portSpec, models, customNodes etc. are all parsed from the YAML by the downloader.
  const slimManifestJson = await agent.loadFromContent(
    WF_NAME,
    workflowJson,
    workflowYaml,
  );
  const manifest = JSON.parse(slimManifestJson);
  if (manifest.error)
    throw new Error(`loadFromContent failed: ${manifest.error}`);
  console.log(
    `  Loaded: inputs=${manifest.inputs?.length ?? 0} params=${manifest.params?.length ?? 0} outputs=${manifest.outputs?.length ?? 0} loras=${manifest.loras?.length ?? 0}`,
  );
  check(
    "manifest id matches",
    manifest.id === WF_NAME,
    manifest.id ?? "(null)",
  );
  for (const p of [
    "prompt_positive",
    "duration_seconds",
    "steps",
    "seed",
    "width",
    "height",
    "fps",
    "sage_attention",
  ]) {
    check(
      `has ${p} param`,
      manifest.params?.some((x: any) => x.name === p),
      JSON.stringify(manifest.params?.map((x: any) => x.name)),
    );
  }
  check(
    "has primary output",
    manifest.outputs?.some((o: any) => o.role === "primary"),
    JSON.stringify(manifest.outputs),
  );

  // 1a. Lora port declarations — the compile-time contract from ports.loras ──────
  console.log(
    "\n── 1a. Verify lora port declarations ────────────────────────────",
  );
  const loras: any[] = manifest.loras ?? [];
  const LORA_PORTS = [1, 2, 3, 4].map((n) => `lora_${n}`);
  check(
    "manifest has 4 lora ports (the baked-in LoRAs are part of workflow.json, not ports)",
    loras.length === LORA_PORTS.length &&
      LORA_PORTS.every((n) => loras.some((l) => l.name === n)),
    JSON.stringify(loras.map((l) => l.name)),
  );
  check(
    "all lora ports target one node",
    loras.length > 0 && new Set(loras.map((l) => String(l.nodeId))).size === 1,
    JSON.stringify(loras.map((l) => l.nodeId)),
  );
  for (const portName of LORA_PORTS) {
    const port = loras.find((l) => l.name === portName);
    check(
      `${portName} has no YAML default and is optional (opt-in append-only port)`,
      port !== undefined &&
        port.default === undefined &&
        port.required === false,
      JSON.stringify(port),
    );
  }

  // 1a'. Reference image ports ────────────────────────────────────────────────
  const inputs: any[] = manifest.inputs ?? [];
  check(
    "manifest has ref0-ref5 (images)",
    inputs.length === 6 &&
      [0, 1, 2, 3, 4, 5].every((n) =>
        inputs.some((i) => i.name === `ref${n}` && i.kind === "image"),
      ),
    JSON.stringify(inputs.map((i) => i.name)),
  );
  check(
    "only ref0 is required",
    inputs.every((i) => i.required === (i.name === "ref0")),
    JSON.stringify(inputs.map((i) => [i.name, i.required])),
  );

  // 1b. Pre-flight: verify model URLs from YAML before spending GPU budget ────
  // Parses YAML directly — authoritative source of URLs, same data loadFromContent used.
  console.log(
    "\n── 1b. Pre-flight: verify model URLs ────────────────────────────",
  );
  const _yaml: { parse: (input: string) => any } = require("yaml");
  const parsedYaml = _yaml.parse(workflowYaml);
  for (const model of parsedYaml.models ?? []) {
    for (const f of model.files ?? []) {
      const url = f.url as string;
      if (!url) {
        console.log(`  [skip] ${model.name} — no public URL`);
        continue;
      }
      const headers: Record<string, string> = {};
      if (url.includes("huggingface.co") && HF_TOKEN) {
        headers["Authorization"] = `Bearer ${HF_TOKEN}`;
      }
      const resp = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers,
      });
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
  // ref0 = the empty set (start frame), ref1 = the character sheet, ref2 = a pose.
  const IMAGE_FIXTURES = ["scene_plate.png", "char_sheet.png", "ref_image_pose.png"];
  const imageUrls: string[] = [];
  for (const file of IMAGE_FIXTURES) {
    imageUrls.push(
      await ensureFixture(
        `${S3_FIXTURE_PREFIX}/${file}`,
        _path.join(MEDIA_FIXTURE_DIR, file),
      ),
    );
  }
  // ref<n> -> fixture picture n (ref0-ref2 exist).
  const refs = (slots: number[]): Record<string, string> =>
    Object.fromEntries(
      slots.map((n) => [`ref${n}`, imageUrls[n]]),
    );

  const promptText = (
    require("node:fs") as typeof import("node:fs")
  )
    .readFileSync(_path.join(SHARED_FIXTURE_DIR, "prompt_positive.txt"), "utf-8")
    .toString()
    .trim();
  const baseParams = {
    prompt_positive: promptText,
    duration_seconds: 5.0,
    steps: 4, // fast draft
    width: 480,
    height: 864,
    fps: 48,
  };

  // A catalog-style lora that is NOT in this workflow's `models:` stanza: exercises the per-call
  // ModelDownloadSpec path (loraJson.models -> the additive requiredModels merge in the download
  // gate). Mirrors the NSFW workspace templates' `h3_moan` catalog entry: the slot carries the
  // catalog name and the file is downloaded as "<catalog name>.safetensors", which is how the
  // Power Lora Loader resolves the slot to the file.
  const LORA_NAME = "h3_moan";
  const LORA_FILE = {
    filename: `${LORA_NAME}.safetensors`,
    url: "https://s3.us-east-1.amazonaws.com/auteur-model-cache-20260905193718168400000001/public/lora/moawxx_000002000.safetensors",
    sha256: "bc0841e216198174ff5937e3ba2f4c9234c163082276cd9f4e5f8889ae12e4e5",
  };
  const loraJson = JSON.stringify({
    selections: { lora_1: { loraName: LORA_NAME, strength: 0.75 } },
    models: [
      {
        folder: "loras",
        name: LORA_FILE.filename,
        url: LORA_FILE.url,
        sha256: LORA_FILE.sha256,
        source: "url",
      },
    ],
  });

  // 4. Submit renders ────────────────────────────────────────────────────────
  console.log(
    "\n── 4. Submit renders ────────────────────────────────────────────",
  );
  const RUNS: { label: string; inputs: Record<string, string>; lora: boolean }[] = [
    { label: "one-ref", inputs: refs([0]), lora: false },
    { label: "refs", inputs: refs([0, 1, 2]), lora: true },
  ];
  const renderIds: string[] = [];
  for (const run of RUNS) {
    const id = await agent.run(
      JSON.stringify(RENDER_PROFILE),
      JSON.stringify(run.inputs),
      JSON.stringify(baseParams),
      undefined,
      undefined,
      run.lora && USE_LORA ? loraJson : undefined,
      undefined, // notifyJson
    );
    console.log(`  [${run.label}] renderId=${id}`);
    check(`${run.label}: renderId non-empty`, id.length > 0, id);
    renderIds.push(id);
  }
  check(
    "renderIds are distinct (inputs and lora selections are hashed into the id)",
    new Set(renderIds).size === renderIds.length,
    JSON.stringify(renderIds),
  );

  // 5. Poll to completion, verify billing and outputs ─────────────────────────
  // A failed render is recorded as a failed check and the remaining renders still run: the
  // scenarios probe independent open questions (see the file header).
  for (let i = 0; i < RUNS.length; i++) {
    const label = RUNS[i].label;
    console.log(`\n── 5.${i + 1} ${label} ─────────────────────────────────────────`);
    let result: any;
    try {
      result = await pollUntilDone(agent, renderIds[i]);
    } catch (err) {
      check(`${label}: render succeeded`, false, String(err));
      continue;
    }
    check(
      `${label}: render succeeded`,
      result.phase === "succeeded",
      `phase=${result.phase}`,
    );
    await checkBillingAfterRender(label, renderIds[i], "success");
    if ((result.outputs?.length ?? 0) === 0) {
      check(`${label}: outputs present`, false, JSON.stringify(result.outputs));
      continue;
    }
    console.log(`  output: ${result.outputs[0].url}`);
    const getResp = await fetch(result.outputs[0].url);
    check(`${label}: output accessible`, getResp.ok, `HTTP ${getResp.status}`);
    const ct = getResp.headers.get("content-type") ?? "";
    check(`${label}: output is video`, ct.startsWith("video/"), ct);
    const size = mp4Size(Buffer.from(await getResp.arrayBuffer()));
    check(
      `${label}: output size is ${baseParams.width}x${baseParams.height}`,
      size?.width === baseParams.width && size?.height === baseParams.height,
      JSON.stringify(size),
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
