/**
 * Resolve & copy the bundled docker-compose.yml + .env.example templates.
 *
 * Templates live under `dist/templates/` after `npm run build` (copied by
 * scripts/copy-templates.js from `src/templates/`). At runtime we resolve
 * paths relative to this module's URL so the package keeps working when
 * installed globally via `npm i -g`.
 */

import { copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** Absolute path to the bundled templates dir. */
export function templatesDir(): string {
  // import.meta.url → file:///.../dist/lib/templates.js
  // we want         → file:///.../dist/templates/
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "templates");
}

export function bundledComposePath(): string {
  return join(templatesDir(), "docker-compose.yml");
}

export function bundledEnvExamplePath(): string {
  return join(templatesDir(), ".env.example");
}

/**
 * Copy bundled docker-compose.yml into installDir, overwriting if present.
 * Always returns the destination path.
 */
export async function copyComposeTemplate(installDir: string): Promise<string> {
  const dest = join(installDir, "docker-compose.yml");
  await copyFile(bundledComposePath(), dest);
  return dest;
}

/**
 * Read the bundled .env.example body (used to seed a fresh .env file).
 */
export async function readEnvExample(): Promise<string> {
  return readFile(bundledEnvExamplePath(), "utf8");
}
