# StellarStream-Pay frontend — React + Vite dashboard.
#
# Vite inlines VITE_* env vars at BUILD time. `src/config.ts` falls back to
# Testnet defaults, so only VITE_CONTRACT_ID (and optionally VITE_BACKEND_URL)
# need to be supplied as build args.

# --- build stage -----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG VITE_CONTRACT_ID=
ARG VITE_BACKEND_URL=http://localhost:4000
ENV VITE_CONTRACT_ID=$VITE_CONTRACT_ID \
    VITE_BACKEND_URL=$VITE_BACKEND_URL

RUN npm run build

# --- serve stage -----------------------------------------------------------
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
