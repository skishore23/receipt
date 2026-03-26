FROM oven/bun:1 AS bun-binary

FROM node:20-bookworm-slim

ARG CODEX_VERSION=0.116.0
ARG RESONATE_VERSION=v0.8.2
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/usr/local/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    dumb-init \
    git \
    jq \
    python3 \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-binary /usr/local/bin/bunx /usr/local/bin/bunx

RUN case "${TARGETARCH}" in \
      amd64) resonate_arch="x86_64" ;; \
      arm64) resonate_arch="aarch64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL \
    "https://github.com/resonatehq/resonate/releases/download/${RESONATE_VERSION}/resonate_linux_${resonate_arch}.tar.gz" \
    -o /tmp/resonate.tar.gz \
  && tar -xzf /tmp/resonate.tar.gz -C /usr/local/bin resonate \
  && chmod +x /usr/local/bin/resonate \
  && rm -f /tmp/resonate.tar.gz

RUN npm install -g "@openai/codex@${CODEX_VERSION}"

WORKDIR /workspace/receipt

COPY docker/entrypoint.sh /usr/local/bin/receipt-entrypoint.sh
COPY docker/healthcheck.sh /usr/local/bin/receipt-healthcheck.sh
RUN chmod +x /usr/local/bin/receipt-entrypoint.sh /usr/local/bin/receipt-healthcheck.sh

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/core/package.json packages/core/package.json
RUN bun install --frozen-lockfile

COPY . .

ENV PORT=8787
ENV JOB_BACKEND=resonate
ENV RESONATE_URL=http://127.0.0.1:8001
ENV RESONATE_GROUP_API=receipt-api
ENV RESONATE_GROUP_DRIVER=receipt-driver
ENV RESONATE_GROUP_CHAT=receipt-chat
ENV RESONATE_GROUP_CONTROL=receipt-control
ENV RESONATE_GROUP_CODEX=receipt-codex
ENV RECEIPT_CODEX_BIN=codex

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/receipt-entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 CMD ["/usr/local/bin/receipt-healthcheck.sh"]
