/**
 * Tiny logger. Honors NO_COLOR (https://no-color.org) automatically via
 * picocolors. Adds a [brikko] prefix matching install.sh visual style.
 */

import pc from "picocolors";

const tag = (color: (s: string) => string): string => color(pc.bold("[brikko]"));

export const log = {
  info: (msg: string): void => {
    process.stdout.write(`${tag(pc.blue)} ${msg}\n`);
  },
  ok: (msg: string): void => {
    process.stdout.write(`${tag(pc.green)} ${msg}\n`);
  },
  warn: (msg: string): void => {
    process.stderr.write(`${tag(pc.yellow)} ${msg}\n`);
  },
  err: (msg: string): void => {
    process.stderr.write(`${tag(pc.red)} ${msg}\n`);
  },
  hint: (msg: string): void => {
    process.stderr.write(`${tag(pc.cyan)} ${pc.dim(msg)}\n`);
  },
  blank: (): void => {
    process.stdout.write("\n");
  },
};
