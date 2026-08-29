FROM node:22-alpine
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
# pnpm 11 default minimumReleaseAge rejects brand-new lockfile deps (js-yaml).
RUN pnpm config set minimumReleaseAge 0 \
 && (pnpm install --prod --frozen-lockfile || pnpm install --prod)
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY dist/web ./dist/web
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "src/server/index.ts"]
