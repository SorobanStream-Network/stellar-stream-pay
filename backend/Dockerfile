# StellarStream-Pay backend — Express API + SQLite event indexer.
#
# Configuration is environment-only (see backend/.env.example). The index lives
# on a volume so a restart resumes from the persisted ledger cursor instead of
# re-backfilling: mount `/data` (DATABASE_PATH defaults to /data/streams.db).

# --- dependencies ----------------------------------------------------------
# better-sqlite3 is a native module; build it against the runtime image's ABI
# with a toolchain, then copy only the compiled node_modules forward.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    DATABASE_PATH=/data/streams.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The index database lives on a volume; the API runs unprivileged.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
