import { defineConfig } from "@playwright/test";

const API_PORT = 8001;
const WEB_PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.pw.ts",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `node e2e/start-backend.mjs ${API_PORT}`,
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Production build: the service worker only exists in built output.
      command: `npm run build && npx vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { HCARE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
