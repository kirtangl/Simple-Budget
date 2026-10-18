# Microsoft's Playwright image: Ubuntu with Chromium and what it needs, and a virtual screen (Xvfb),
# so the browser runs with a window like a person's rather than headless. The playwright version in
# package.json must match this image's. An exact version and its digest; Dependabot proposes updates.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
LABEL org.opencontainers.image.source="https://github.com/kirtangl/Simple-Budget" \
      org.opencontainers.image.description="Simple Budget price-checker: supermarket prices for the Shopping tab"

WORKDIR /app
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev && npm cache clean --force
COPY server.js start.sh ./
COPY lib ./lib
COPY stores ./stores

ARG APP_VERSION=
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    PORT=8090 \
    DATA_DIR=/data
# pwuser comes with the image. /data keeps the browser's profile (its cookies) and the visit times.
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
VOLUME ["/data"]
EXPOSE 8090

HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://localhost:8090/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# The virtual screen for the browser's window, then the price-checker (see start.sh).
CMD ["/app/start.sh"]
