# QuickJS / Golem feasibility spike: pose + outfit recommender query stage

Scratch dir: /private/tmp/claude-501/-Users-hannes-work-auteur-content-lake/a7f981a9-0af7-48c6-90a3-a3c398ae9d8d/scratchpad/quickjs-spike
Files: gen.js (data), lib.js (code under test), run.js (timing, Node and QuickJS), mem.js (live memory). No video-harness source was changed.

## 1. Runtime capabilities (evidence from the compiled artifact)

No wasm-rquickjs sources are on disk (no `wasm-rquickjs*` dir, no cargo registry crate). The vendored SDK
(`vendor/*.tgz`, `node_modules/@golemcloud/*`) is only the TS SDK. The real evidence is the compiled guest component
`video-harness/golem-temp/agents/video_harness_harness.wasm` (138 MB). I ran `strings` on it (1.85M lines).

- Runtime identity: `wasm-rquickjs 0.2.3`, `rquickjs-core-0.10.0`, QuickJS-ng (memory dump header "QuickJS-ng memory usage").
- **No `WebAssembly` global.** Every `WebAssembly` string hit in the embedded JS shims (30 hits) is a "not supported in
  WebAssembly environment" error message (cluster, dns, http2, https.createServer, readline, perf_hooks histograms).
  There is no `globalThis.WebAssembly`, no `WebAssembly.instantiate`/`Module`/`compile` definition, and no `instantiateStreaming`.
  Assume it is absent. A runtime check (`typeof WebAssembly`) in a deployed agent would confirm this, and I did not run one.
  Native Rust-backed shims exist for fs, encoding, hrtime, `memory_usage`, Intl and vm. Consequence: pure JS or TS only.
  Wasm-based dependencies (onnxruntime-web, hnswlib-wasm, transformers.js) cannot load.
- `TextDecoder`/`TextEncoder`: present (hundreds of hits, a native `encode`/`decode`/`encode_into`/`supports_encoding`
  binding). `new TextDecoder().decode(bytes)` is already used in src (mail-agent.ts:83, base-reasoning-agent.ts:186, design-task-agent.ts:604).
- `Float32Array`/`DataView`: standard QuickJS-ng typed arrays (`Float32Array` also appears in the Node shims), and `DataView` is a core builtin.
- `fetch` -> `Response.arrayBuffer()/text()/json()`: present (Node-style shim wrapping wasi:http). The existing rule is to buffer the whole body inside `atomically()` (root CLAUDE.md, "Never interleave WASI filesystem writes with HTTP response body reads").
- `process.memoryUsage()` is shimmed from a native `memory_usage` (rss/heapTotal/external/arrayBuffers). `process.constrainedMemory()` returns 0.
- **Limits on memory and fuel: nothing on disk.** There is no `set_memory_limit`/`set_max_stack` string in the guest, so no JS-level heap cap is configured by wasm-rquickjs. The only bound is the wasm32 linear memory (4 GiB max) and whatever the golem executor enforces (a component memory/resource limit is not defined in this repo). No fuel or epoch settings are in the repo's golem.yaml or CLAUDE.md. Unknown: executor-side limits. Test by deploying a throwaway agent.
- `quickjs-emscripten` quirk: `setMaxStackSize(8 MiB)` made even trivial code throw an empty error. I left the stack default.

## 2. Performance proxy

Synthetic data (gen.js, seeded): 1,700 items (60-word doc, 8 concepts from 40, 10 focus weights, meta; 340 poses x 5 angles) plus a 40x8 lexicon.
index.json = **1.68 MB**. Vector file = 1700x384 float32 = 2.6 MB raw, 3.48 MB base64.
Median of 5 runs (after one warm-up), milliseconds. QuickJS = quickjs-emscripten 2025-09-13 build (QuickJS-ng lineage, interpreter compiled to wasm, in Node/V8).
The query is: tokenize, lexicon n-gram match (1-3 grams), BM25 over all docs, concept dot product, RRF, top-30, group by pose, MMR pick of 3.

| step | QuickJS (wasm interp) | Node (V8 JIT) |
|---|---|---|
| (a) JSON.parse of 1.68 MB | 11-14 ms | 2-3 ms |
| (b) build BM25 inverted index | 131-135 ms | 12-13 ms |
| (c) one query (BM25 + concepts + RRF + MMR) | 5-6 ms | 2 ms |
| (d1) base64 decode 3.48 MB -> Float32Array (hand-written JS loop) | 372-388 ms | 4-5 ms |
| (d2) cosine pass 1700x384 | 39-44 ms | 0-1 ms |
| (c') query with dense list fused in | 6-7 ms | 2-3 ms |
| marshal 1.7 MB + 3.5 MB strings into VM (host side only, not applicable in Golem) | ~20 ms | n/a |

Live memory in QuickJS after the data is retained and GC'd (`computeMemoryUsage().memory_used_size`):
empty 0.1 MiB, parsed index + BM25 **4.0 MiB**, plus 1700x384 Float32Array **6.5 MiB** total.
The 1.68 MB string and the 3.5 MB base64 string are transient and can be dropped after parsing.
Both queries return the same top-3 poses in QuickJS and Node, so the code is faithful.

Reading:
- Cold-start cost of the sparse path (parse + build) is about 150 ms in the interpreter. Per query is 5-7 ms. Both are very affordable.
- Dense vectors are affordable for compute (a cosine pass costs 40 ms) but not for naive base64 decode in JS (about 380 ms).
  Mitigations: use `Buffer.from(b64,'base64')` or `atob` if the shim backs them natively (not measured here, needs a check in a real agent),
  or fetch the vectors as binary (`resp.arrayBuffer()` -> `new Float32Array(buf)`, zero decode), or use int8-quantised vectors (4x smaller), or precompute and store the cold vectors on disk. Binary fetch is the best option.
- Caveat: wasm-rquickjs runs the same QuickJS-ng under a wasmtime JIT inside Golem rather than under V8, so absolute numbers can differ by ~2x either way. The ratio to Node (5-10x on loops, 10x JSON) is the useful part.
  Budget for 3x the QuickJS numbers: cold load < 0.6 s, query < 25 ms.
- A fuel/epoch limit (unknown) is the only thing that could bite: the cold build is about 135 ms of interpreter time.
  Do it once per agent instance, not per query.

## 3. Oplog and durability (from root CLAUDE.md and src)

- Large blobs in a durable agent: fetch output is recorded in the oplog (including streaming reads, plus ~160 B frame entries per read for LLM streams).
  The documented answers (root CLAUDE.md, "Specific golem patterns"):
  1. Prefetch to VFS: a separate invocation does `atomically(() => { fetch -> writeFileSync(VFS) })`, then later invocations read the VFS (no HTTP on replay). Buffer the whole body (`arrayBuffer()`/`text()`) inside `atomically()`, and do not interleave VFS writes with body reads.
  2. **But the fork deletes the VFS when an idle agent unloads, and its filesystem calls are recorded too.** Never let a file's existence decide host calls (replay trap `expected keyvalue::eventual::set, got filesystem::types::descriptor::stat_at`, 2026-10-28). Anything that decides behaviour belongs in KV or the snapshot; VFS files are only caches (see `src/workspace/prefetch-index.ts`).
  3. Keep HTTP out of durable oplogs entirely by doing it in an **ephemeral** agent (LlmCallAgent pattern: durable caller -> `createPromise` -> ephemeral `.trigger()` -> `awaitPromise`; fixed ~4 oplog entries per call).
  4. Snapshots are oplog volume too (every:1 agents wrote 43 GB in 5 h): use `util/snapshot-json.ts`.
  5. `persist-nothing` does NOT shrink the oplog. `yieldForSnapshot()` is deprecated/dangerous (self-promise deadlock): do not use.
- Ephemeral agents in the repo (`@agent({ mode: "ephemeral" })`): `LlmCallAgent` (src/llm/llm-call-agent.ts:141), `TakeArchiveIngestAgent` (src/take-archive/ingest-agent.ts:52),
  `WorkspaceReadAgent` (workspace-read-agent.ts:166, HTTP-mounted, KV-backed reads), `IdentityAgent`, `AccountApiAgent`, `BillingIngestAgent`, `BillingMaintenanceAgent`, `BillingWebhookAgent`,
  `RegistryAgent`, `ResumeAgent`, `PolicyWorker`. Caveat: `mail-sender.ts:18` notes ephemeral is "currently broken, .get() fails" for that case, and the billing notes say a failing SQL statement in a transaction hangs an ephemeral invocation. Ephemeral agents also get a fresh instance (and VFS and heap) per call, so a `ReferenceIndexAgent` would re-parse the index every call unless the instance is reused. Reuse is not guaranteed for ephemeral agents.
- Model for a `ReferenceIndexAgent`: **`WorkspaceReadAgent`** is the closest (ephemeral, read-only, answers from a KV view published by a durable writer, async, typed result) combined with **`LlmCallAgent`**'s
  trigger/promise handoff when called from a durable agent: the caller gets back only a small result (top-3 poses), never the index.
  The ~4 MiB heap and ~150 ms cold build would be paid per call if ephemeral instances are not reused; if that is too slow, use a durable singleton (keyed agent) holding the built index in memory and a KV/snapshot of the raw text, with a content-addressed key like `prefetchWorkflowBodyKvKey` (md5).
- `lora_index`: **not a fetch.** It is a WorkerAgent tool (src/workspace/workspace-agent-tools.ts:726/1138) that calls `loraIndex()` = `formatLoraIndex(JSON.parse(this.agent.getWorkspaceLoras()))`,
  i.e. the catalog already sits in the WorkspaceAgent's memory/snapshot (resolved from the workspace spec/YAML at open), served by an in-process RPC. The read-only HTTP twin `get-lora-index` is served by `WorkspaceReadAgent` from the KV view the WorkspaceAgent publishes. The catalog is small, so it is no precedent for a 1.7 MB blob. The nearest precedent for large blobs is `prefetch-index.ts`: KV with content-addressed keys, one body per key, the index record without bodies.

## Recommendation
Pure-JS BM25 + concepts + RRF + MMR is feasible in the Golem runtime (5-7 ms/query, ~4 MiB, ~150 ms cold build). Skip any WASM-based or `WebAssembly` dependency.
Dense 384-d vectors are feasible if shipped as binary (`arrayBuffer` -> `Float32Array`; +2.5 MiB, +40 ms/query pass), not base64 decoded in JS.
Host the index in KV (content-addressed) plus an ephemeral reader modeled on `WorkspaceReadAgent`; fetch it with `atomically()` + `arrayBuffer()` in a separate prefetch invocation, never trusting VFS existence.
Open items to verify in a real agent: `typeof WebAssembly`, native `atob`/`Buffer.from(...,'base64')` speed, ephemeral instance reuse, executor memory/fuel limits.
