// Writes the declarations of the web modules tsconfig.web.json checks, beside each module, from its
// JSDoc: the build and src read them. The old ones go first, since tsc would read a module's own
// declarations as its input and refuse to overwrite them. tsc writes a declaration for every file
// the modules reach, so one that imports a stub importing src would write one beside each src file:
// any declaration it writes outside the checked modules is removed again, and the run fails.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The files among tsc's `--listEmittedFiles` output (`TSFILE: <path>` lines) that aren't the
 * declarations of the modules `include` names, as paths under `root`.
 * @param {string} output
 * @param {string[]} include
 * @param {string} root
 */
export function strays(output, include, root) {
  const wanted = new Set(include.map((f) => f.replace(/\.js$/, ".d.ts")));
  return output
    .split("\n")
    .filter((l) => l.startsWith("TSFILE: "))
    .map((l) => relative(root, resolve(root, l.slice("TSFILE: ".length).trim())))
    .filter((f) => !wanted.has(f));
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { include } = JSON.parse(readFileSync(new URL("../tsconfig.web.json", import.meta.url), "utf8"));
  for (const file of include) rmSync(new URL(`../${file.replace(/\.js$/, ".d.ts")}`, import.meta.url), { force: true });
  const tsc = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.web-types.json", "--listEmittedFiles"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const output = tsc.stdout ?? "";
  process.stdout.write(
    output
      .split("\n")
      .filter((l) => l && !l.startsWith("TSFILE: "))
      .map((l) => `${l}\n`)
      .join(""),
  );
  const extra = strays(output, include, root);
  for (const f of extra) rmSync(resolve(root, f), { force: true });
  if (extra.length) {
    console.error(
      `scripts/web-types.mjs: tsc wrote declarations outside the checked web modules, now removed: ${extra.join(", ")}. A checked module reaches them through an import (a stub that imports src, say); convert that module first.`,
    );
    process.exit(1);
  }
  process.exit(tsc.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
