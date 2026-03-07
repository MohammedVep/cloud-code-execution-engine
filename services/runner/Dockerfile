FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/common ./packages/common
COPY services/runner ./services/runner

RUN npm install
RUN npm run build --workspace @ccee/common && npm run build --workspace @ccee/runner

FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache python3 openjdk17-jdk util-linux tini \
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
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "services/runner/dist/index.js"]
