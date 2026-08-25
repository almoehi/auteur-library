Preview release running here. One break: `flattenModelPaths` going away surfaced a
backslash in our lora paths that had been silently flattened for months — correct
behaviour, clear error, our fix.

Timing, as promised. I varied four things on the same render and only one moved it:
GPU tier l40s→h100 175s→170s, orbit frames 124→32 175s→166s, clip resolution 4×
the pixels 122s→124s, and models loaded 56.7GB→17.1GB **175s→24s**. So roughly
twelve seconds of a character sheet is sampling and the rest is reading weights —
which is why a better card changes nothing. It's also paid twice per render:
prefetch-models finishes at 11:38:11, the render container starts at 11:39:16, so
65s of a second cold start because the first one exited. Seven models took the same
101s as three, so that part is startup, not file work.

Three things worth a look, all in deploy.py: `scaledown_window=2`, no
`enable_memory_snapshot`, and `@modal.enter()` being empty with ComfyUI started
lazily inside `run()`. Haven't touched any of them.

Separately: a workspace agent stopped answering its own API for about ten minutes
mid-render while the harness and every other workspace answered in under 100ms,
then recovered on its own. Longer note with all of this if it's useful.
