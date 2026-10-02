FROM node:22-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source.
COPY src ./src

CMD ["node", "src/cli.js", "--poll"]