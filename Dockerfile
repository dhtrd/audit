# PRE-AUDIT OS — production image.
# Node 22 is required for the built-in node:sqlite module.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Persist the SQLite DB and uploaded files on a mounted volume at /data.
ENV DATABASE_FILE=/data/dev.db
ENV UPLOAD_DIR=/data/uploads
# Copy the built app + deps (App Router runs from .next at runtime).
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.mjs ./next.config.mjs
# src + tsconfig are needed only so `npm run db:seed` (tsx) can create the
# first admin inside the container; the running app serves from .next.
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
RUN mkdir -p /data/uploads
VOLUME ["/data"]
EXPOSE 3000
# JWT_SECRET must be provided at runtime (-e JWT_SECRET=...). Seed the first
# admin once with: docker exec ... npm run db:seed
CMD ["npm", "start"]
