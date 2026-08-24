# Reference images reach the workspace but not the renderer

**Setup:** local harness, Modal a100 backend, MiniMax H3 bundle generated per
clip by our studio. Three reference images attached to one direct render.

## What works

- Files upload through `mintUploadUrls` → PUT → `importUserArtifact`. Every PUT
  returned ok.
- The artifact lands correctly: `user_reference_material`, status `approved`,
  files `IMG_2478.jpg`, `IMG_2479.jpg`, `IMG_2480.jpg`.
- The worker agent finds them on its own and passes them to the `wf_` tool's
  image ports — it did this from its system prompt alone, before the task text
  even mentioned them.
- The same file is retrievable through the harness API right now: our proxy
  fetches `IMG_2478.jpg` from that artifact and gets HTTP 200, 255 036 bytes,
  a valid JPEG (1170x1384).

## What fails

The render dies immediately with:

```
download_url HTTP 404 for
https://s3.us-west-2.amazonaws.com/sandbox-file-exchange-zx4k9m2p/
  direct-mt7poies-zpl0d-direct%401.0/workspace/user-impo…: Not Found
```

(the URL is cut off in the log at ~120 chars, so we cannot see the key or
whether a signature followed)

So: the bytes are in the exchange bucket — the PUTs succeeded and the harness
serves the file — but the URL the renderer is given for them 404s.

## What we could not determine

Whether the `getUrl` handed back by `mintUploadUrls` (which we store on the
artifact file, and which the worker then passes on) points at a different key
than the `uploadUrl` we PUT to, or whether something downstream truncates or
re-encodes it. Note the `%40` for the `@` in the workspace id — if the object
key holds a literal `@`, a percent-encoded request would miss it.

## Questions

1. Is the `getUrl` from `mintUploadUrls` the right thing to put on an imported
   artifact file, or should an artifact file reference the object some other way?
2. Should a `wf_*` image input receive that URL directly, or an artifact id /
   file reference that the harness resolves on the render side?
3. Is there a worked example of a workflow with `ports.inputs` of `kind: image`
   being driven from a user-supplied artifact? `iamcs_wan22_svi` declares three
   such inputs, and copying its shape is what we did — but we have not seen it
   run with a user file.

## Separately, two smaller things from the same day

- **Model downloads run on the GPU class.** `ComfyWorker` handles every command
  including `download_models`, so a 1.25 GB Civitai pull sits on an a100 for
  minutes — and a download that fails retries there too. One failing file cost
  17 minutes of a100 before the run gave up. A cpu function with the same volume
  mount would do it.
- **The fileId in a civitai download URL is not honoured.** Asked for
  `?fileId=3097100` (hmpussy_v6_epoch30) and the bytes that arrived were
  `vagassist_e40`'s — the version's *first* file. Same pattern on another model,
  where a request for `_07000` fetched `_05500` and 403'd. Civitai itself serves
  the right file for each fileId; we checked with a range request and read the
  content-disposition. Anything with more than one file per version is currently
  unreachable except its first.
