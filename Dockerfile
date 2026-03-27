FROM oven/bun:1 AS bun-binary

FROM node:20-bookworm-slim AS base

ARG CODEX_VERSION=0.116.0
ARG RESONATE_VERSION=v0.8.2
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/workspace/receipt/.receipt/bin:/usr/local/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    awscli \
    bash \
    bubblewrap \
    ca-certificates \
    curl \
    dumb-init \
    git \
    gh \
    iproute2 \
    jq \
    lsof \
    openssh-client \
    procps \
    psmisc \
    python3 \
    ripgrep \
    sqlite3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-binary /usr/local/bin/bunx /usr/local/bin/bunx

RUN case "${TARGETARCH}" in \
      amd64) resonate_arch="x86_64" ;; \
      arm64) resonate_arch="aarch64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL \
    "https://github.com/resonatehq/resonate/releases/download/${RESONATE_VERSION}/resonate_linux_${resonate_arch}.tar.gz.sha256" \
    -o /tmp/resonate.tar.gz.sha256 \
  && curl -fsSL \
    "https://github.com/resonatehq/resonate/releases/download/${RESONATE_VERSION}/resonate_linux_${resonate_arch}.tar.gz" \
    -o /tmp/resonate.tar.gz \
  && (cd /tmp && sha256sum -c /tmp/resonate.tar.gz.sha256) \
  && tar -xzf /tmp/resonate.tar.gz -C /usr/local/bin resonate \
  && chmod +x /usr/local/bin/resonate \
  && resonate serve --help >/dev/null 2>&1 \
  && rm -f /tmp/resonate.tar.gz /tmp/resonate.tar.gz.sha256

RUN npm install -g "@openai/codex@${CODEX_VERSION}"

WORKDIR /workspace/receipt

COPY docker/entrypoint.sh /usr/local/bin/receipt-entrypoint.sh
COPY docker/healthcheck.sh /usr/local/bin/receipt-healthcheck.sh
COPY docker/debug-env.sh /usr/local/bin/receipt-debug-env
RUN chmod +x /usr/local/bin/receipt-entrypoint.sh /usr/local/bin/receipt-healthcheck.sh /usr/local/bin/receipt-debug-env

ENV PORT=8787
ENV DATA_DIR=/workspace/receipt/.receipt/data
ENV RECEIPT_DATA_DIR=/workspace/receipt/.receipt/data
ENV JOB_BACKEND=resonate
ENV RECEIPT_WORKDIR=/workspace/receipt
ENV HOME=/workspace/receipt/.receipt/home
ENV CODEX_HOME=/workspace/receipt/.receipt/home/.codex
ENV RECEIPT_ISOLATED_CODEX_HOME_ROOT=/workspace/receipt/.receipt/home/.codex/runtime
ENV RESONATE_URL=http://127.0.0.1:8001
ENV RESONATE_GROUP_API=receipt-api
ENV RESONATE_GROUP_DRIVER=receipt-driver
ENV RESONATE_GROUP_CHAT=receipt-chat
ENV RESONATE_GROUP_CONTROL=receipt-control
ENV RESONATE_GROUP_CODEX=receipt-codex
ENV RECEIPT_CODEX_BIN=codex

FROM base AS source

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/core/package.json packages/core/package.json
RUN bun install --frozen-lockfile

COPY . .
RUN chmod +x .receipt/bin/receipt \
  && ln -sf /workspace/receipt/.receipt/bin/receipt /usr/local/bin/receipt

FROM source AS dev

ENV RECEIPT_DOCKER_MODE=dev
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/receipt-entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 CMD ["/usr/local/bin/receipt-healthcheck.sh"]

FROM source AS prod

RUN bun run build
ENV RECEIPT_DOCKER_MODE=prod
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/receipt-entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 CMD ["/usr/local/bin/receipt-healthcheck.sh"]
