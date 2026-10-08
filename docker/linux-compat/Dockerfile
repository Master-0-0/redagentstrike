# Compatibility lab, not a production deployment image.
FROM node:24-bookworm AS baseline
ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-dev build-essential procps curl fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.7.0
WORKDIR /app
COPY backend/pyproject.toml backend/pyproject.toml
RUN python3 -m venv backend/.venv && python3 -m venv backend/.venv-mitm
COPY backend/src backend/src
COPY backend/addons backend/addons
COPY backend/dsh backend/dsh
COPY backend/pocs backend/pocs
RUN backend/.venv/bin/pip install -e './backend[dev]' && backend/.venv-mitm/bin/pip install mitmproxy
RUN backend/.venv/bin/python -m playwright install --with-deps chromium
COPY web-ui/package*.json web-ui/
RUN cd web-ui && npm ci
COPY web-ui web-ui
COPY dsh-cairn-search/src dsh-cairn-search/src
RUN cd web-ui && npm run build
COPY deepseek-harness deepseek-harness
RUN cd deepseek-harness && pnpm install --frozen-lockfile
ARG DSH_CLIENT_COMMIT_HASH
RUN test -n "$DSH_CLIENT_COMMIT_HASH" && cd deepseek-harness && DSH_CLIENT_COMMIT_HASH="$DSH_CLIENT_COMMIT_HASH" pnpm run build
COPY dsh-cairn-search dsh-cairn-search
COPY dsh-theme-hacker dsh-theme-hacker
COPY dsh-intel dsh-intel
COPY dsh-findings dsh-findings
RUN for plugin in dsh-cairn-search dsh-theme-hacker dsh-intel dsh-findings; do \
      (cd "$plugin" && npm ci && npm run build) || exit; done
COPY .dsh/skills .dsh/skills
COPY backend/tests backend/tests
COPY backend/scripts backend/scripts
COPY start.sh stop.sh ./
COPY docker/linux-compat/run-tests.sh /usr/local/bin/compat-tests
ENV PATH="/app/backend/.venv/bin:${PATH}"
CMD ["bash", "/usr/local/bin/compat-tests"]

# Complete Linux test environment; baseline target preserves the missing-tool reproduction.
FROM baseline AS linux-compat
RUN apt-get update && apt-get install -y --no-install-recommends lsof bubblewrap musl-tools \
    && rm -rf /var/lib/apt/lists/*
RUN cd deepseek-harness/native/landlock-run && pnpm run build:native
RUN cd deepseek-harness && pnpm dsh plugin --profile web add \
    /app/dsh-cairn-search /app/dsh-theme-hacker /app/dsh-intel /app/dsh-findings
RUN mkdir -p /root/.dsh/.agent-presets/cairn \
    && cp -R dsh-cairn-search/preset/. /root/.dsh/.agent-presets/cairn/ \
    && npm --prefix dsh-cairn-search run link-peers \
    && npm --prefix dsh-intel run link-peers && npm --prefix dsh-intel run install-preset \
    && npm --prefix dsh-findings run link-peers && npm --prefix dsh-findings run install-preset
COPY docker/linux-compat/*.py docker/linux-compat/*.mjs docker/linux-compat/*.sh /opt/linux-compat/
CMD ["bash", "/opt/linux-compat/run-tests.sh"]
