import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");

const cleanEnv = (extra = {}) =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(([, value]) => value !== undefined && value !== null),
  );

const processes = [
  spawn(process.execPath, ["server/server.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: cleanEnv({ PORT: process.env.PORT ?? "8787" }),
  }),
  spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", process.env.VITE_PORT ?? "5174"], {
    cwd: root,
    stdio: "inherit",
    env: cleanEnv(),
  }),
];

const shutdown = () => {
  processes.forEach((child) => child.kill());
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

processes.forEach((child) => {
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown();
  });
});
