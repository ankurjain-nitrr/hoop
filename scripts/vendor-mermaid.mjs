// Copies one pinned release of mermaid's minified file into web/vendor/, with its version and hash.
// The pages serve that copy, so diagrams draw without reaching another host, and installs of hoop
// don't pull in mermaid's dependencies. Usage: node scripts/vendor-mermaid.mjs <version>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/vendor-mermaid.mjs <version>, such as 12.1.0");
  process.exit(2);
}
const source = `https://registry.npmjs.org/mermaid/-/mermaid-${version}.tgz`;
const res = await fetch(source);
if (!res.ok) throw new Error(`${source}: ${res.status}`);
const work = mkdtempSync(join(tmpdir(), "hoop-mermaid-"));
try {
  writeFileSync(join(work, "mermaid.tgz"), Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xzf", join(work, "mermaid.tgz"), "-C", work, "package/dist/mermaid.min.js", "package/LICENSE"]);
  const out = new URL("../web/vendor/", import.meta.url).pathname;
  mkdirSync(out, { recursive: true });
  const file = readFileSync(join(work, "package/dist/mermaid.min.js"));
  writeFileSync(join(out, "mermaid.min.js"), file);
  writeFileSync(join(out, "mermaid.LICENSE"), readFileSync(join(work, "package/LICENSE")));
  const sha256 = createHash("sha256").update(file).digest("hex");
  writeFileSync(join(out, "mermaid.json"), `${JSON.stringify({ version, source, sha256 }, null, 2)}\n`);
  console.log(`web/vendor/mermaid.min.js: mermaid ${version}, sha256 ${sha256}, ${file.length} bytes`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
