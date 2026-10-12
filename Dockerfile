FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/kirtangl/Simple-Budget" \
      org.opencontainers.image.description="Simple Budget: a self-hosted household budget"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

# Set by the release workflow to the release's version, e.g. 0.8.0-beta.1.
ARG APP_VERSION=
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/app/data/budget.db \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/session >/dev/null || exit 1
CMD ["node", "src/server.js"]
