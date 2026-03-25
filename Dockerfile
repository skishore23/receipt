FROM oven/bun:1.2.20 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build

FROM oven/bun:1.2.20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/app/.receipt/data

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/bunfig.toml ./bunfig.toml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/prompts ./prompts
COPY --from=build /app/dist ./dist
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/architecture.md ./architecture.md
COPY --from=build /app/docs ./docs
COPY --from=build /app/profiles ./profiles

EXPOSE 8787
VOLUME ["/app/.receipt/data"]

CMD ["bun", "src/server.ts"]
