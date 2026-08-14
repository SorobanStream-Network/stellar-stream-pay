# StellarStream-Pay backend — Express indexer / API.
#
# All configuration comes from environment variables (see backend/.env.example):
#   PORT, RPC_URL, HORIZON_URL, STREAM_CONTRACT_ID
# No committed .env file is copied into the image.

# --- install stage ---------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime stage ---------------------------------------------------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as the unprivileged `node` user (the API only reads, never writes).
USER node
EXPOSE 4000
CMD ["node", "src/index.js"]
