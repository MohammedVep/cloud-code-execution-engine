FROM node:24.16.0-trixie-slim AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/common ./packages/common
COPY services/runner ./services/runner

RUN npm install
RUN npm run build --workspace @ccee/common && npm run build --workspace @ccee/runner

FROM node:24.16.0-trixie-slim
WORKDIR /app

ARG JAVA_VERSION=25.0.3
ARG JAVA_BUILD=9
ENV JAVA_HOME=/opt/jdk-${JAVA_VERSION}
ENV PATH="${JAVA_HOME}/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    g++ \
    golang-go \
    mono-mcs \
    mono-runtime \
    python3 \
    tini \
    util-linux \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
    amd64) adoptium_arch="x64" ;; \
    arm64) adoptium_arch="aarch64" ;; \
    *) echo "Unsupported architecture for JDK ${JAVA_VERSION}: $arch" >&2; exit 1 ;; \
    esac \
  && curl -LfsSo /tmp/openjdk.tar.gz \
    "https://api.adoptium.net/v3/binary/version/jdk-${JAVA_VERSION}%2B${JAVA_BUILD}/linux/${adoptium_arch}/jdk/hotspot/normal/eclipse?project=jdk" \
  && mkdir -p "${JAVA_HOME}" \
  && tar -xzf /tmp/openjdk.tar.gz -C "${JAVA_HOME}" --strip-components=1 \
  && rm -f /tmp/openjdk.tar.gz \
  && java -version 2>&1 | grep "openjdk version \\\"${JAVA_VERSION}\\\"" \
  && javac -version 2>&1 | grep "javac ${JAVA_VERSION}" \
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
