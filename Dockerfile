FROM node:24-alpine AS deps

WORKDIR /app

# better-sqlite3 (a dependency of @actual-app/api) compiles from source and ships no
# prebuilt binaries, so the install needs a toolchain. It stays in this stage.
RUN apk add --no-cache python3 make g++

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


FROM node:24-alpine

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Application source.
COPY src ./src

# Actual's data directory. The bind mount in docker-compose.yml must be writable
# by the unprivileged `node` user (uid 1000).
RUN mkdir -p /data && chown node:node /data

USER node

CMD ["node", "src/cli.js", "--poll"]
