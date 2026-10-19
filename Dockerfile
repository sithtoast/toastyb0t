FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first so this layer is cached between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Settings live in /app/data; mount a volume there so they survive rebuilds.
RUN mkdir -p data && chown node:node data
VOLUME ["/app/data"]

# Inside a container the dashboard must listen on all interfaces to be reachable
# through the published port. Which host interfaces it's exposed on is decided
# by the port mapping in docker-compose.yml.
ENV WEB_HOST=0.0.0.0 \
    WEB_PORT=3000
EXPOSE 3000

USER node
CMD ["node", "src/index.js"]
