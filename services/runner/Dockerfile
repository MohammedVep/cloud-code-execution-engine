FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/common ./packages/common
COPY services/runner ./services/runner

RUN npm install
RUN npm run build --workspace @ccee/common && npm run build --workspace @ccee/runner

FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    golang-go \
    mono-mcs \
    mono-runtime \
    openjdk-17-jdk-headless \
    python3 \
    tini \
    util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace \
  && chown -R node:node /workspace

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/common/package.json ./packages/common/package.json
COPY --from=builder /app/services/runner/dist ./services/runner/dist
COPY --from=builder /app/services/runner/package.json ./services/runner/package.json

RUN npm install --omit=dev --workspace @ccee/common --workspace @ccee/runner
RUN chmod -R a+rX /app

USER node
ENV RUN_ROOT=/workspace
ENV GOCACHE=/workspace/.cache/go-build
ENV GOTMPDIR=/workspace/.gotmp
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "services/runner/dist/index.js"]
