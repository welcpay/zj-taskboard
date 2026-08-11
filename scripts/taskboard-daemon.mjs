#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

function parseArgs(argv) {
  const options = { host: "127.0.0.1", port: 47823 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") options.host = argv[++index];
    else if (argument === "--port") options.port = Number(argv[++index]);
    else throw new Error(`Unknown daemon option: ${argument}`);
  }
  if (options.host !== "127.0.0.1") throw new Error("Taskboard daemon must use 127.0.0.1");
  if (options.port !== 47823) throw new Error("Taskboard daemon must use port 47823");
  return options;
}

const options = parseArgs(process.argv.slice(2));
const runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportDirectory = path.resolve(runtimeDirectory, "..", "..");
const manifest = JSON.parse(await readFile(
  path.join(runtimeDirectory, "runtime-manifest.json"),
  "utf8",
));
const generation = randomUUID();

process.env.CODEX_TASKBOARD_HOST = options.host;
process.env.CODEX_TASKBOARD_PORT = String(options.port);
process.env.CODEX_TASKBOARD_DATA_DIR = supportDirectory;
process.env.CODEX_TASKBOARD_DAEMON_VERSION = manifest.version;
process.env.CODEX_TASKBOARD_RUNTIME_PATH = runtimeDirectory;
process.env.CODEX_TASKBOARD_RUNTIME_GENERATION = generation;

await writeFile(
  path.join(supportDirectory, "daemon.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    version: manifest.version,
    pid: process.pid,
    generation,
    runtimePath: runtimeDirectory,
    url: "http://127.0.0.1:47823",
  }, null, 2)}\n`,
  { mode: 0o600 },
);

const { createTaskboardServer } = await import("./server/app.mjs");
const app = createTaskboardServer();
await app.listen({ host: options.host, port: options.port });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
