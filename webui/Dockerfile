# The studio as a container: the adapter-node build plus the one binary it
# shells out to. Two stages so the image ships the build output and ffmpeg,
# not a toolchain — the built server has no runtime dependencies of its own
# (everything in package.json is dev-only), so no node_modules travel either.
#
# Runs next to the harness, which it reaches at AUTEUR_HARNESS_URL and which
# reaches it back at host.docker.internal:5290 to fetch the workflow bundles
# the studio rewrites per render. See deploy/README.md for the whole picture.
FROM node:22-slim AS build
RUN npm i -g pnpm@10
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim
# ffmpeg: last-frame cuts, duration probes and the join. ffmpegPath() finds it
# on PATH after every repo-local candidate misses, which in this image they do.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./
# 5290 is not cosmetic: the address the studio writes into every workspace
# YAML defaults to host.docker.internal:5290, and the harness fetches the
# bundle back from there. BODY_SIZE_LIMIT: adapter-node caps request bodies at
# 512K by default, which would refuse every reference image (up to 200 MB).
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5290 BODY_SIZE_LIMIT=Infinity
EXPOSE 5290
CMD ["node", "build/index.js"]
