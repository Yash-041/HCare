/**
 * Starts the real FastAPI backend (SQLite, throwaway DB) so the TypeScript sync engine is
 * tested end-to-end against the actual server, not a mock of it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    apiUrl: string;
  }
}

const PORT = 8765;
const backendDir = fileURLToPath(new URL("../../backend", import.meta.url));

function pythonPath(): string {
  const candidates = [
    path.join(backendDir, ".venv", "Scripts", "python.exe"),
    path.join(backendDir, ".venv", "bin", "python"),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`backend venv not found in ${backendDir}/.venv (see README)`);
  return found;
}

async function waitForHealth(url: string, proc: ChildProcess, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`backend exited with code ${proc.exitCode}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("backend did not become healthy in time");
}

export default async function setup(project: TestProject) {
  const dir = mkdtempSync(path.join(tmpdir(), "hcare-e2e-"));
  const proc = spawn(
    pythonPath(),
    ["-m", "uvicorn", "app.main:create_app", "--factory", "--port", String(PORT), "--log-level", "warning"],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        DATABASE_URL: `sqlite:///${path.join(dir, "e2e.db").replace(/\\/g, "/")}`,
        SEED_DEMO_USERS: "1",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const url = `http://127.0.0.1:${PORT}`;
  await waitForHealth(url, proc);
  project.provide("apiUrl", url);

  return async () => {
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(dir, { recursive: true, force: true });
  };
}
