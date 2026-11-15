# A headless Marshal host: the portable runtime (the desktop's pinned packs), marshal-sdk, the extensions
# it serves, and Chromium for the sessions' browser and the run's screenshots. Built from the context
# image/prepare.mjs writes; nothing from a developer machine's node_modules goes in.
FROM node:24.19.0-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /opt/marshal-sdk
COPY package.json ./
COPY vendor ./vendor
RUN pnpm install --prod --config.node-linker=hoisted

# The Chromium of the Playwright that @playwright/mcp drives, with its system libraries; one browser serves
# the sessions (Playwright MCP), Page Studio's own checks and the run's screenshots.
RUN node node_modules/playwright-core/cli.js install --with-deps chromium \
 && ln -s "$(find /ms-playwright -type f -name chrome -path '*chrome-linux*' | head -n 1)" /usr/local/bin/chromium \
 && /usr/local/bin/chromium --version

COPY dist ./dist
COPY poc ./poc
COPY extensions ./extensions
COPY inventory.json ./

RUN useradd --create-home --shell /bin/bash marshal && mkdir -p /run-data && chown marshal:marshal /run-data
USER marshal
# Containers have no user namespaces for Chromium's sandbox; the container is the sandbox.
ENV MARSHAL_SDK_CHROME=/usr/local/bin/chromium \
    PAGE_STUDIO_CHROME=/usr/local/bin/chromium \
    MARSHAL_SDK_CHROME_NO_SANDBOX=1
ENTRYPOINT ["node", "/opt/marshal-sdk/dist/src/cli.js"]
