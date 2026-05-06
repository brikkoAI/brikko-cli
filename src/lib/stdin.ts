/**
 * Read all of stdin as a UTF-8 string.
 *
 * Used by:
 *   - `brikko chat -`       → prompt from stdin
 *   - `brikko anonymize`    → text from stdin (default)
 *   - `brikko restore`      → text from stdin (default)
 *   - `brikko safe-chat`    → prompt from stdin (default)
 *
 * Returns "" if stdin is a TTY (no piped input). Callers must handle that
 * case explicitly — typically by erroring out with a usage hint.
 */

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** True when something is being piped into us (`echo foo | brikko ...`). */
export function hasPipedStdin(): boolean {
  return !process.stdin.isTTY;
}
