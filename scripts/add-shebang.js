#!/usr/bin/env node
/**
 * Build-time: prepend `#!/usr/bin/env node` to dist/cli.js + chmod +x on POSIX.
 * tsc can't emit shebangs natively (https://github.com/microsoft/TypeScript/issues/24968).
 */

import { readFile, writeFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "..", "dist", "cli.js");

const SHEBANG = "#!/usr/bin/env node\n";
const body = await readFile(cliPath, "utf8");

if (!body.startsWith("#!")) {
  await writeFile(cliPath, SHEBANG + body, "utf8");
  console.log("[brikko-cli build] shebang added → dist/cli.js");
} else {
  console.log("[brikko-cli build] shebang already present");
}

if (process.platform !== "win32") {
  await chmod(cliPath, 0o755);
  console.log("[brikko-cli build] dist/cli.js → 755");
}
