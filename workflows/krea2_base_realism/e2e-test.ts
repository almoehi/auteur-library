/**
 * WorkflowAgent E2E — krea2_base_realism
 *
 * Covers the workflow's non-lora params (prompt_positive/prompt_negative/width/height/steps/
 * cfg/seed) plus the ports.loras contract for dynamic LoRA injection into node 315
 * (Power Lora Loader (rgthree)): the always-on turbo + filter-bypass LoRAs are baked into
 * workflow.json's authored slots (kept verbatim at bind time — no port declaration needed),
 * and lora_1–lora_4 are opt-in style/character ports whose resolved lora is APPENDED after the
 * authored slots (inactive unless a caller supplies a selection). See workflow.yaml's
 * `ports.loras` comments for the keep-authored-slots + append contract this depends on
 * (bindWorkflow()/appendLoraSlot() in video-harness/src/render/manifest.ts).
 *
 * NOTE on scope of the lora assertions below: WorkflowAgent's public RPC surface (load/
 * loadFromContent/run/runStatus) does not expose the actual bound ComfyUI prompt for
 * inspection — runStatus() returns phase/outputs/failure/logs, never the submitted graph. So the
 * nested `{ on, lora, strength }` shape written into node 315's inputs cannot be asserted
 * end-to-end purely via RPC here; that exact shape was verified statically instead by calling
 * buildManifestFromSpec()/bindWorkflow() directly against this bundle's real workflow.json/
 * workflow.yaml (see the task's final report — not part of this script). What IS verified here
 * via real RPC calls:
 *   - manifest.loras exposes all four declared opt-in ports with the right nodeId/no-default/
 *     required:false (the compile-time contract — proves workflow.yaml parses into the
 *     expected port set).
 *   - a render submitted with a lora_1 selection is accepted and produces a renderId distinct
 *     from an otherwise-identical render with no lora selection (computeRenderId() hashes
 *     loraSelections — see workflow-agent.ts's run()), which is the only externally observable
 *     signal that the selection actually reached the render pipeline without a live-stack
 *     bound-prompt inspection hook.
 *   - the lora_1 render completes and produces a valid image output, proving the selection
 *     doesn't crash or get rejected by WorkflowAgent.run() itself.
 *   - render billing: after both renders, the owning WorkspaceAgent's billingInfo() (same id as
 *     the WorkflowAgent's SCOPE — WorkflowAgent.renderBillingStart/End key billing records by
 *     `this.scope`) holds one event per renderId with the right provider/GPU/workflow/outcome
 *     and timestamps, and its cent totals are internally consistent.
 * An "unrecognized lora name is rejected" scenario is intentionally NOT included: that
 * validation lives one layer up, in WorkerAgent's dispatch-time lora catalog resolution
 * (lora_index tool) — WorkflowAgent.run()'s own loraJson parameter is documented (see its JSDoc
 * in workflow-agent.ts) to trust the caller's selections as already-validated. A WorkflowAgent-
 * level e2e test has no path to exercise that rejection.
 *
 * Cost: REAL GPU (Modal/Beam/RunPod per COMPUTE_BACKEND, l40s, two renders + ~25 GB first-run
 * model download) and S3. The script tears the endpoint down in `finally`; still verify no
 * orphaned provider resources afterwards (root CLAUDE.md "cloud resources").
 *
 * Run inside the harness container (standard fat-image deployment; `/tmp/deploy-app.env` holds the
 * deployed golem env name, single quotes keep `$(cat ...)` inside the container):
 *   docker exec -it harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/krea2_base_realism/e2e-test.ts --yes'
 *
 * Dev-tree fallback (local golem server, not via fat image; fork golem binary):
 *   cd video-harness && source .env && export WORK_DIR="$(cd .. && pwd)" && \
 *     golem -L repl --script-file ../workflows/krea2_base_realism/e2e-test.ts --yes
 */

// ── CONFIG ───────────────────────────────────────────────────────────────────
const WF_NAME = "krea2_base_realism";
const GPU_TYPE = "l40s"; // Krea 2 BF16 + Qwen 3 VL 4B requires ~24 GB VRAM minimum
const TIMEOUT_SEC = 5400;
const PROVISION_TIMEOUT_MS = 35 * 60 * 1000; // ~25 GB models on first run
const RENDER_TIMEOUT_MS = 60 * 60 * 1000;
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
    `  Loaded: params=${manifest.params?.length ?? 0} outputs=${manifest.outputs?.length ?? 0} loras=${manifest.loras?.length ?? 0}`,
  );
  check(
    "manifest id matches",
    manifest.id === WF_NAME,
    manifest.id ?? "(null)",
  );
  for (const p of [
    "prompt_positive",
    "prompt_negative",
    "width",
    "height",
    "steps",
    "cfg",
    "seed",
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
  const LORA_PORTS = ["lora_1", "lora_2", "lora_3", "lora_4"];
  check(
    "manifest has 4 lora ports (lora_1–lora_4 — turbo + filter-bypass are baked into workflow.json, not ports)",
    loras.length === LORA_PORTS.length &&
      LORA_PORTS.every((n) => loras.some((l) => l.name === n)),
    JSON.stringify(loras.map((l) => l.name)),
  );
  check(
    "all lora ports target node 315",
    loras.every((l) => String(l.nodeId) === "315"),
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

  // 3. Read fixture prompts ────────────────────────────────────────────────────
  console.log(
    "\n── 3. Read fixture prompts ───────────────────────────────────────",
  );
  const _nodeFs = require("node:fs") as typeof import("node:fs");
  const prompt_positiveText = _nodeFs
    .readFileSync(_path.join(FIXTURE_DIR, "prompt_positive.txt"), "utf-8")
    .toString()
    .trim();
  const prompt_negativeText = _nodeFs
    .readFileSync(_path.join(FIXTURE_DIR, "prompt_negative.txt"), "utf-8")
    .toString()
    .trim();

  const baseParams = {
    prompt_positive: prompt_positiveText,
    prompt_negative: prompt_negativeText,
    width: 896,
    height: 1152,
    steps: 6,
    cfg: 1.0,
  };

  // 4. Submit render WITHOUT any lora selection ───────────────────────────────
  // The baked-in turbo/filter-bypass slots in workflow.json are kept verbatim at bind time
  // (unverifiable via RPC — see the file-header note); this call just proves the workflow
  // renders normally with no lora selection supplied at all, and captures its renderId for
  // the distinctness check below.
  console.log(
    "\n── 4. Submit render — no lora selection ──────────────────────────",
  );
  const renderIdNoLora = await agent.run(
    JSON.stringify(RENDER_PROFILE),
    JSON.stringify({}),
    JSON.stringify(baseParams),
    undefined,
    undefined,
    undefined,
  );
  console.log(`  renderId=${renderIdNoLora}`);
  check(
    "renderId (no lora) non-empty",
    renderIdNoLora.length > 0,
    renderIdNoLora,
  );

  // 5. Submit render WITH a lora_1 selection ──────────────────────────────────
  // Uses a real, non-CivitAI (HuggingFace) LoRA that is NOT part of this workflow's static
  // `models:` stanza — "krea2_retroanime.safetensors" from Comfy-Org/Krea-2's own official
  // `loras/` folder (same repo/family as the base checkpoint, sha256-verified below). This
  // deliberately exercises the NEW per-call ModelDownloadSpec path (WorkerAgent.
  // resolveLoraSelections() -> WorkflowAgent.run()'s loraJson.models -> the additive
  // requiredModels merge in the download gate) end-to-end, rather than reusing an
  // already-cached model file that would never touch that code path.
  const LORA_1_FILE = {
    name: "krea2_retroanime",
    url: "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/loras/krea2_retroanime.safetensors",
    filename: "krea2_retroanime.safetensors",
    sha256: "ca42107783d9e517c5d62cb9a9db9ab2ba4887d90e9dad97a9d1a7fe6ff14c56",
  };
  console.log(
    "\n── 5. Submit render — with lora_1 selection (new HF download) ─────",
  );
  const renderIdWithLora = await agent.run(
    JSON.stringify(RENDER_PROFILE),
    JSON.stringify({}),
    JSON.stringify(baseParams),
    undefined,
    undefined,
    JSON.stringify({
      selections: {
        lora_1: {
          loraName: LORA_1_FILE.filename,
          strength: 0.8,
        },
      },
      models: [
        {
          folder: "loras",
          name: LORA_1_FILE.filename,
          url: LORA_1_FILE.url,
          sha256: LORA_1_FILE.sha256,
          source: "huggingface",
        },
      ],
    }),
  );
  console.log(`  renderId=${renderIdWithLora}`);
  check(
    "renderId (with lora) non-empty",
    renderIdWithLora.length > 0,
    renderIdWithLora,
  );
  check(
    "renderId differs between no-lora and with-lora calls (computeRenderId hashes loraSelections)",
    renderIdWithLora !== renderIdNoLora,
    `noLora=${renderIdNoLora} withLora=${renderIdWithLora}`,
  );

  // 6. Poll both renders to completion ────────────────────────────────────────
  console.log(
    "\n── 6. Poll renders to completion ─────────────────────────────────",
  );
  console.log("  [no-lora render]");
  const resultNoLora = await pollUntilDone(agent, renderIdNoLora);
  check(
    "no-lora render succeeded",
    resultNoLora.phase === "succeeded",
    `phase=${resultNoLora.phase}`,
  );
  console.log("  [with-lora render]");
  const resultWithLora = await pollUntilDone(agent, renderIdWithLora);
  check(
    "with-lora render succeeded",
    resultWithLora.phase === "succeeded",
    `phase=${resultWithLora.phase}`,
  );

  // 6b. Verify billing records ─────────────────────────────────────────────────
  console.log(
    "\n── 6b. Verify billing records ────────────────────────────────────",
  );
  await checkBillingAfterRender("no-lora", renderIdNoLora, "success");
  await checkBillingAfterRender("with-lora", renderIdWithLora, "success");

  // 7. Verify outputs ─────────────────────────────────────────────────────────
  console.log(
    "\n── 7. Verify outputs ─────────────────────────────────────────────",
  );
  for (const [label, result] of [
    ["no-lora", resultNoLora],
    ["with-lora", resultWithLora],
  ] as const) {
    if (result.phase === "succeeded" && result.outputs?.length > 0) {
      const outputUrl = result.outputs[0].url;
      const getResp = await fetch(outputUrl);
      check(
        `${label}: output accessible`,
        getResp.ok,
        `HTTP ${getResp.status}`,
      );
      const ct = getResp.headers.get("content-type") ?? "";
      check(`${label}: output is image`, ct.startsWith("image/"), ct);
      await getResp.arrayBuffer();
    } else {
      check(
        `${label}: outputs present`,
        (result.outputs?.length ?? 0) > 0,
        JSON.stringify(result.outputs),
      );
    }
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
