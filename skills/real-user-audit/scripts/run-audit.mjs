#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync("node", ["./packages/cli/dist/index.js", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: new URL("../../..", import.meta.url)
});

process.exitCode = result.status ?? 1;
