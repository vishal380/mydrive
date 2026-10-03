FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_PATH=/app/backend/storage

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY frontend/ /app/frontend/

RUN mkdir -p /app/backend/storage /app/backend/logs \
    && chown -R node:node /app/backend

USER node

EXPOSE 3000

CMD ["node", "server.js"]
