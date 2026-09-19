import { spawn } from "node:child_process";
import { validateEnvironment } from "./validate-env.mjs";

try {
  validateEnvironment(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Environment validation failed.");
  process.exit(1);
}

const child = spawn(process.execPath, ["server.js"], {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
