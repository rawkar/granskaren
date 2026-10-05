#!/usr/bin/env node
// Startar CLI:t. Kör mot dist/ om det finns (npm run build), annars via tsx mot src/.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli.js");
if (existsSync(dist)) {
  await import(dist);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(path.join(here, "..", "src", "cli.ts"));
}
