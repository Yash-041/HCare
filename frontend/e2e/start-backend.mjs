// Starts the FastAPI backend on a throwaway SQLite DB for browser tests.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("../../backend", import.meta.url));
const python = [
  path.join(backendDir, ".venv", "Scripts", "python.exe"),
  path.join(backendDir, ".venv", "bin", "python"),
].find(existsSync);
if (!python) throw new Error("backend/.venv not found");

const port = process.argv[2] ?? "8001";
const dbFile = path.join(mkdtempSync(path.join(tmpdir(), "hcare-pw-")), "pw.db").replace(/\\/g, "/");
const proc = spawn(python, ["-m", "uvicorn", "app.main:create_app", "--factory", "--port", port], {
  cwd: backendDir,
  env: { ...process.env, DATABASE_URL: `sqlite:///${dbFile}`, SEED_DEMO_USERS: "1" },
  stdio: "inherit",
});
const stop = () => proc.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
proc.on("exit", (code) => process.exit(code ?? 0));
