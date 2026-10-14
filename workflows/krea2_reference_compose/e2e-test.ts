/**
 * WorkflowAgent E2E (SPIKE) — krea2_reference_compose
 *
 * Question: can Krea 2 generate a NEW composition from reference images (ReferenceLatent on an
 * empty latent) while keeping identity + place? Renders a small matrix:
 *   a  character + location, low-angle prompt
 *   b  character + location, bird's-eye prompt
 *   c  character only, new pose/angle
 *   d  baseline: no references (plain t2i), same prompt as (a)
 * and prints the output URLs (download them and compare by eye).
 *
 * Optional ports + chains: bindWorkflow() only strips the DIRECT consumer edge of an absent
 * optional loader, which leaves ImageScaleToTotalPixels/VAEEncode with a missing required input
 * (ComfyUI validation failure). Until the harness prunes transitively, this script loads a
 * graph VARIANT per run that deletes the scale/encode/reference nodes of the absent refs and
 * re-chains the present ones (the loaders stay as orphans so port bindings still resolve).
 *
 * Reference URLs: `ref_urls.json` next to this file ({ character, outfit, location } presigned GET
 * URLs; not committed). Fixture PNGs of the two used references are committed for provenance.
 *
 * Cost: REAL GPU (COMPUTE_BACKEND, l40s) + ~25 GB first-run model download. Teardown in finally.
 *   docker exec harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/krea2_reference_compose/e2e-test.ts --yes'
 */

const WF_NAME = "krea2_reference_compose";
const GPU_TYPE = "l40s";
const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND ?? "modal";
const PROVISION_TIMEOUT_MS = 35 * 60 * 1000;
const RENDER_TIMEOUT_MS = 30 * 60 * 1000;
const WIDTH = 1280;
const HEIGHT = 720;
const STEPS = 6;

const _path = require("node:path") as typeof import("node:path");
const _fs = require("node:fs") as typeof import("node:fs");
const WORK_DIR = process.env.WORK_DIR ?? "/work";
const FIXTURE_DIR = _path.join(WORK_DIR, "workflows", WF_NAME);

const RENDER_PROFILE = {
  tier: "standard",
  profile: {
    compute: { backend: COMPUTE_BACKEND, gpuType: GPU_TYPE, timeoutSec: 3600, maxAttempts: 1 },
  },
};

const STYLE = "A children's comic illustration with bold ink outlines and flat colours. ";
const BRIANNA =
  "Brianna, a young girl with dark braided pigtails, freckles and a yellow star hairclip, wearing mint-green star-pattern pajamas";

type PortName = "reference_image_1" | "reference_image_2" | "reference_image_3";
interface Case {
  id: string;
  refs: Partial<Record<PortName, "character" | "outfit" | "location">>;
  prompt: string;
  /** FluxKontextMultiReferenceLatentMethod value (default "index"). */
  method?: "index" | "offset" | "index_timestep_zero";
  /** Ignored at cfg=1; only here because renderId hashes params + media but NOT the graph. */
  negativeTag?: string;
  /** Control: swap the two ClownsharK passes for one core KSampler (euler/simple). */
  coreSampler?: boolean;
}
const CASES: Case[] = [
  {
    id: "a_lowangle_char_loc",
    refs: { reference_image_1: "character", reference_image_3: "location" },
    prompt:
      STYLE +
      "Low-angle shot from the floor, camera tilted up. Brianna from Picture 1 sits cross-legged on the bed in the bedroom from Picture 2 (the same room: window with a toy castle, door with a 'No Boys Allowed' sign, bookshelf), looking up at the ceiling and smiling.",
  },
  {
    id: "b_birdseye_char_loc",
    refs: { reference_image_1: "character", reference_image_3: "location" },
    prompt:
      STYLE +
      "Overhead bird's-eye view looking straight down. Brianna from Picture 1 lies on the bed in the bedroom from Picture 2 (the same room and furniture), arms spread wide, seen from directly above.",
  },
  {
    id: "c_char_only_new_pose",
    refs: { reference_image_1: "character" },
    prompt:
      STYLE +
      "Brianna from Picture 1 running to the right in a dynamic three-quarter side view, mid-stride, laughing, full body, plain light background.",
  },
  {
    id: "e_lowangle_timestep_zero",
    method: "index_timestep_zero",
    negativeTag: "variant-timestep-zero",
    refs: { reference_image_1: "character", reference_image_3: "location" },
    prompt:
      STYLE +
      "Low-angle shot from the floor, camera tilted up. Brianna from Picture 1 sits cross-legged on the bed in the bedroom from Picture 2 (the same room: window with a toy castle, door with a 'No Boys Allowed' sign, bookshelf), looking up at the ceiling and smiling.",
  },
  {
    id: "f_lowangle_offset",
    method: "offset",
    negativeTag: "variant-offset",
    refs: { reference_image_1: "character", reference_image_3: "location" },
    prompt:
      STYLE +
      "Low-angle shot from the floor, camera tilted up. Brianna from Picture 1 sits cross-legged on the bed in the bedroom from Picture 2 (the same room: window with a toy castle, door with a 'No Boys Allowed' sign, bookshelf), looking up at the ceiling and smiling.",
  },
  {
    id: "g_lowangle_core_ksampler",
    coreSampler: true,
    negativeTag: "variant-core-ksampler",
    refs: { reference_image_1: "character", reference_image_3: "location" },
    prompt:
      STYLE +
      "Low-angle shot from the floor, camera tilted up. Brianna from Picture 1 sits cross-legged on the bed in the bedroom from Picture 2 (the same room: window with a toy castle, door with a 'No Boys Allowed' sign, bookshelf), looking up at the ceiling and smiling.",
  },
  {
    id: "d_baseline_no_refs",
    refs: {},
    prompt:
      STYLE +
      `Low-angle shot from the floor, camera tilted up. ${BRIANNA} sits cross-legged on a bed in a grey child's bedroom with a window showing a toy castle, a door with a 'No Boys Allowed' sign and a bookshelf, looking up at the ceiling and smiling.`,
  },
];

/** Drops scale/encode/reference nodes of absent refs and re-chains the present ones. */
function variantJson(baseJson: string, present: PortName[], method = "index", coreSampler = false): string {
  const g = JSON.parse(baseJson);
  const slots: PortName[] = ["reference_image_1", "reference_image_2", "reference_image_3"];
  let prev: [string, number] = ["6", 0];
  slots.forEach((port, idx) => {
    const n = idx + 1;
    const [scale, enc, ref] = [`41${n}`, `42${n}`, `43${n}`];
    if (!present.includes(port)) {
      delete g[scale];
      delete g[enc];
      delete g[ref];
      return;
    }
    g[ref].inputs.conditioning = prev;
    prev = [ref, 0];
  });
  if (present.length === 0) {
    delete g["440"];
    for (const s of ["265", "274"]) g[s].inputs.positive = ["6", 0];
  } else {
    g["440"].inputs.conditioning = prev;
    g["440"].inputs.reference_latents_method = method;
  }
  if (coreSampler) {
    g["450"] = {
      inputs: { model: ["315", 0], positive: g["265"].inputs.positive, negative: ["272", 0], latent_image: ["232", 0], seed: ["276", 0], steps: STEPS, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 },
      class_type: "KSampler",
      _meta: { title: "Core KSampler (control)" },
    };
    g["8"].inputs.samples = ["450", 0];
    // 265/274 stay as orphans (ComfyUI prunes them) so the steps/cfg/seed port bindings still resolve.
  }
  return JSON.stringify(g);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const failures: string[] = [];

async function pollUntilDone(agent: any, renderId: string): Promise<any> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const result = JSON.parse((await agent.runStatus(renderId)) ?? "null");
    if (!result) throw new Error(`runStatus null for ${renderId}`);
    if (result.phase !== lastPhase) {
      console.log(`    phase=${result.phase} attempts=${result.attempts ?? 0}`);
      lastPhase = result.phase;
    }
    if (result.phase === "succeeded") return result;
    if (result.phase === "failed") {
      const f = result.failure ?? {};
      throw new Error(`render failed: kind=${f.kind ?? "?"} — ${f.message ?? "(no message)"}\n${JSON.stringify(result.logs ?? "").slice(0, 3000)}`);
    }
    await sleep(10_000);
  }
  throw new Error("render timed out");
}

const refUrls = JSON.parse(_fs.readFileSync(_path.join(FIXTURE_DIR, "ref_urls.json"), "utf8"));
const baseJson = _fs.readFileSync(_path.join(FIXTURE_DIR, "workflow.json"), "utf8");
const yaml = _fs.readFileSync(_path.join(FIXTURE_DIR, "workflow.yaml"), "utf8");
const agent = await WorkflowAgent.get(WF_NAME, `e2e-${WF_NAME}-${Date.now()}`);

try {
  console.log(`=== WorkflowAgent E2E (spike) — ${WF_NAME} ===`);
  const loaded = JSON.parse(await agent.loadFromContent(WF_NAME, baseJson, yaml));
  if (loaded.error) throw new Error(`loadFromContent failed: ${loaded.error}`);
  console.log(`  inputs=${JSON.stringify(loaded.inputs?.map((i: any) => i.name))}`);

  const t0 = Date.now();
  await agent.provision();
  for (;;) {
    const st = JSON.parse(await agent.backendStatus());
    if (st.status === "provisioned") break;
    if (st.status === "failed") throw new Error(`Provisioning failed: ${st.error}`);
    if (Date.now() - t0 > PROVISION_TIMEOUT_MS) throw new Error("provision timeout");
    await sleep(20_000);
  }
  console.log(`  provisioned in ${Math.round((Date.now() - t0) / 1000)}s`);

  // CASE_IDS=e_...,f_... (comma-separated) restricts the run to those cases.
  const only = (process.env.CASE_IDS ?? "").split(",").filter(Boolean);
  for (const c of CASES.filter((x) => only.length === 0 || only.includes(x.id))) {
    console.log(`\n── ${c.id} ──`);
    const ports = Object.keys(c.refs) as PortName[];
    // load() is idempotent (keeps the first manifest) — drop it so the variant graph takes effect.
    await agent.removeWorkflow();
    const re = JSON.parse(await agent.loadFromContent(WF_NAME, variantJson(baseJson, ports, c.method, c.coreSampler), yaml));
    if (re.error) throw new Error(`variant load failed: ${re.error}`);
    const media: Record<string, string> = {};
    for (const p of ports) media[p] = refUrls[c.refs[p]!];
    const start = Date.now();
    const renderId = await agent.run(
      JSON.stringify(RENDER_PROFILE),
      JSON.stringify(media),
      JSON.stringify({ prompt_positive: c.prompt, width: WIDTH, height: HEIGHT, steps: STEPS, seed: 4242, ...(c.negativeTag ? { prompt_negative: c.negativeTag } : {}) }),
      undefined, undefined, undefined, undefined,
    );
    try {
      const result = await pollUntilDone(agent, renderId);
      console.log(`  RESULT ${c.id} secs=${Math.round((Date.now() - start) / 1000)} url=${result.outputs?.[0]?.url}`);
    } catch (err) {
      console.log(`  ✗ ${c.id}: ${err}`);
      failures.push(`${c.id}: ${err}`);
    }
  }
} finally {
  try {
    await agent.teardown();
    console.log("  teardown() completed");
  } catch (err) {
    console.log(`  teardown threw: ${err}`);
  }
}
console.log(failures.length ? `FAILED:\n${failures.join("\n")}` : "ALL RENDERS OK");
