#!/usr/bin/env node
/**
 * Build-time: copy src/templates/* into dist/templates/.
 * tsc only emits .ts → .js; non-ts assets must be copied manually.
 */

import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "src", "templates");
const dst = resolve(root, "dist", "templates");

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`[brikko-cli build] templates copied → ${dst}`);
