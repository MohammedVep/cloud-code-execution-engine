FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/common ./packages/common
COPY services/worker ./services/worker

RUN npm install
RUN npm run build --workspace @ccee/common && npm run build --workspace @ccee/worker

FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache docker-cli

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/common/package.json ./packages/common/package.json
COPY --from=builder /app/services/worker/dist ./services/worker/dist
COPY --from=builder /app/services/worker/package.json ./services/worker/package.json

RUN npm install --omit=dev --workspace @ccee/common --workspace @ccee/worker
RUN chmod -R a+rX /app

CMD ["node", "services/worker/dist/index.js"]
