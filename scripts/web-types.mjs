// Writes the declarations of the web modules tsconfig.web.json checks, beside each module, from its
// JSDoc: the build and src read them. The old ones go first, since tsc would read a module's own
// declarations as its input and refuse to overwrite them.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { include } = JSON.parse(readFileSync(new URL("../tsconfig.web.json", import.meta.url), "utf8"));
for (const file of include) rmSync(new URL(`../${file.replace(/\.js$/, ".d.ts")}`, import.meta.url), { force: true });
const tsc = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.web-types.json"], {
  cwd: root,
  stdio: "inherit",
});
process.exit(tsc.status ?? 1);
