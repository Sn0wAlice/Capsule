# syntax=docker/dockerfile:1

# ffmpeg is ~110 MB and changes about as often as the base image, so it goes in
# the first layer: a dependency or source change never re-downloads it.
FROM node:24-alpine AS base
RUN apk add --no-cache ffmpeg
WORKDIR /app

# Dependencies are their own stage so that editing src/ never re-runs npm ci.
# The cache mount keeps the npm download cache between builds, so even a
# lockfile change only re-links packages instead of re-fetching them.
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
# Copy only what the two processes need. Tests, CI config and the compose files
# stay out of the image and out of this layer's cache key.
COPY package.json package-lock.json ./
COPY migrations ./migrations
COPY src ./src

EXPOSE 3000

CMD ["node", "src/app.js"]
