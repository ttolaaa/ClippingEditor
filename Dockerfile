# syntax=docker/dockerfile:1.7
# Multi-stage build for the Clipping web app (Next.js standalone output).
# All video processing happens in the user's browser, so the runtime image only needs Node.

ARG NODE_VERSION=22

# ---------- deps: install exact dependencies from the lockfile
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
# postinstall copies ffmpeg.wasm into public/ffmpeg
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------- build: compile the production bundle
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/public/ffmpeg ./public/ffmpeg
COPY . .
RUN npm run build

# ---------- runtime: minimal image with only the standalone server
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

ARG GIT_SHA=dev
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Clipping" \
      org.opencontainers.image.description="AI viral reel generator - turn long videos into captioned 9:16 clips in the browser" \
      org.opencontainers.image.source="https://github.com/ttolaaa/ClippingEditor" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV APP_VERSION=${GIT_SHA}

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
