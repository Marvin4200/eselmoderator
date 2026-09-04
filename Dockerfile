FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ default-mysql-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production
USER node
CMD ["node", "index.js"]
