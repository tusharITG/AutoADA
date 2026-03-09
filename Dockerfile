# =============================================================================
# STAGE 1: Build stage — install dependencies
# =============================================================================
# Start from a slim Node.js 18 image based on Debian (not Alpine — Chromium
# needs glibc-based Linux for its binary dependencies).
FROM node:18-slim AS build

WORKDIR /app

# Copy only package files first. Docker caches each layer — if package.json
# hasn't changed, it won't re-run npm install (saves minutes on rebuilds).
COPY package.json package-lock.json* ./

# Install production dependencies only (no devDependencies).
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true tells Puppeteer "don't download your
# own Chromium, we'll provide the system one." This saves ~280MB.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci --omit=dev

# =============================================================================
# STAGE 2: Runtime stage — lean final image
# =============================================================================
FROM node:18-slim

# Install Chromium and all the system libraries it needs to run.
# These are the shared libraries (.so files) that Chromium dynamically links
# against. Without them, Puppeteer will crash with "missing .so" errors.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    # Clean up the apt cache to keep the image small
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium we just installed,
# instead of trying to find/download its own.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy node_modules from the build stage (already installed, no need to
# re-run npm install).
COPY --from=build /app/node_modules ./node_modules

# Copy the rest of our application code.
COPY . .

# Cloud Run sets the PORT environment variable automatically.
# This is just a default fallback for local testing.
ENV PORT=3000
EXPOSE 3000

# Run as non-root user for security. Chromium doesn't need root because
# we're using --no-sandbox (which your code already sets).
RUN groupadd -r autoada && useradd -r -g autoada -m autoada
USER autoada

# Start the web server.
CMD ["node", "src/server.js"]
