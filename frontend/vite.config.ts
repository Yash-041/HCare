import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

const API_TARGET = process.env.HCARE_API_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt", // never reload mid-consultation; the user chooses when to update
      includeAssets: ["icon.svg"],
      manifest: {
        name: "HCare: Offline Clinical Assistant",
        short_name: "HCare",
        description: "Offline-first patient records for rural health workers",
        theme_color: "#0f766e",
        background_color: "#f8fafc",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell only. The 27 MB ONNX runtime WASM is cached on first use instead (below).
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        runtimeCaching: [
          {
            // API traffic is never cached: offline handling belongs to the sync engine.
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
          },
          {
            // Hashed (immutable) WASM bundles, e.g. the ONNX runtime used by Whisper.
            urlPattern: ({ url }) => url.pathname.startsWith("/assets/") && url.pathname.endsWith(".wasm"),
            handler: "CacheFirst",
            options: { cacheName: "hcare-wasm", expiration: { maxEntries: 10 } },
          },
          {
            // Tesseract's worker script and WASM engine come from jsdelivr; versioned and
            // immutable, so cache-first. (Its language data is cached in IndexedDB by
            // tesseract.js, and Whisper weights + ONNX runtime by transformers.js in Cache
            // Storage, so those are deliberately NOT cached twice here.)
            urlPattern: ({ url }) =>
              url.hostname === "cdn.jsdelivr.net" && /\/npm\/tesseract\.js(-core)?@/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "hcare-ocr-engine",
              expiration: { maxEntries: 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: true,
    proxy: {
      // Same-origin API in dev and prod (nginx) avoids CORS and mixed-content issues.
      "/api": { target: API_TARGET, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
  preview: {
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
