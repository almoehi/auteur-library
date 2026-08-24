Hi Hannes — reference images for character consistency. I got the workflow
exposing them as you suggested, but nothing I try gets the file to the renderer.
Three attempts, three different failures, all on the harness side. Local harness,
Modal a100, MiniMax H3, bundle generated per clip and served over HTTP.

**What works.** Upload via mintUploadUrls → PUT → importUserArtifact: every PUT
ok, artifact `user_reference_material` approved with all three files. The same
file fetches fine through the harness API right now — 200, valid 255KB JPEG. The
worker agent finds the files unprompted and passes them to the image ports.

**1. Artifact URL → 404 at the renderer.**
```
download_url HTTP 404 for https://s3.../sandbox-file-exchange-.../
  direct-mt7poies-zpl0d-direct%401.0/workspace/user-impo…
```
Later attempts gave 400 on the same URL. We store `slot.getUrl` from
mintUploadUrls on the artifact file and the agent passes that on. Note the `%40`
for the `@` in the workspace id — if the object key holds a literal `@`, a
percent-encoded GET would miss it.

**2. Bundle `assets` → never fetched.** Declared the images under `assets:` with
matching bare filenames in the LoadImage nodes, per §3.9. ComfyUI then looked for
a local file:
```
FileNotFoundError: '/ComfyUI/input/ref_2.jpg'  [node=ref_2 type=LoadImage]
```
No substitution happened, and our server logged no request for those basenames —
the harness never tried to fetch them. Is `assets` resolved relative to the
bundle URL when the bundle is served over HTTPS rather than from a repo?

**Questions.** Is `getUrl` the right thing to put on an imported artifact file?
Should a `kind: image` port receive a URL, or an artifact/file reference the
harness resolves render-side? Is there a working example of an image port driven
from a user-uploaded file? `iamcs_wan22_svi` declares three but I have not seen
it run with one.

**Two unrelated things from the same day, both cheap fixes.**

*Model downloads run on the GPU class.* ComfyWorker handles every command
including `download_models`, so a 1.25GB Civitai pull holds an a100 for minutes,
and a failing one retries there. One bad file cost 17 minutes of a100. A cpu
function with the same volume mount would do it.

*The fileId in a civitai download URL is ignored.* Asked for `?fileId=3097100`
(hmpussy_v6_epoch30) and got vagassist_e40's bytes — the version's *first* file;
sha check caught it. Same on another model: asked `_07000`, got `_05500`, which
403s. Civitai serves the right file per fileId — verified with a range request
and content-disposition. Any version with more than one file is currently
unreachable except its first.
