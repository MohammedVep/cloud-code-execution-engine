FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/common ./packages/common
COPY services/api ./services/api

RUN npm install
RUN npm run build --workspace @ccee/common && npm run build --workspace @ccee/api

FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/common/package.json ./packages/common/package.json
COPY --from=builder /app/services/api/dist ./services/api/dist
COPY --from=builder /app/services/api/public ./services/api/public
COPY --from=builder /app/services/api/package.json ./services/api/package.json

RUN npm install --omit=dev --workspace @ccee/common --workspace @ccee/api

CMD ["node", "services/api/dist/index.js"]
