// hoop's one version number. package.json holds it; the plugin's plugin.json and package-lock.json
// carry the same number, and the plugin runs the package of its own version (plugins/hoop/scripts/hoop.sh).
//
//   npm version X.Y.Z --no-git-tag-version   sets package.json and package-lock.json, then runs this
//                                            script (the npm "version" script), which sets plugin.json
//   npx tsx scripts/version.ts --check       exits 1, naming each file, when the numbers differ
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = "plugins/hoop/.claude-plugin/plugin.json";

const read = (file: string): unknown => JSON.parse(readFileSync(root + file, "utf8"));
const field = (v: unknown, key: string): unknown => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined);

/** Each place that carries hoop's version number, with the number it holds there. */
export function versions(): { place: string; version: unknown }[] {
  const lock = read("package-lock.json");
  return [
    { place: "package.json", version: field(read("package.json"), "version") },
    { place: "package-lock.json", version: field(lock, "version") },
    { place: 'package-lock.json packages[""]', version: field(field(field(lock, "packages"), ""), "version") },
    { place: PLUGIN, version: field(read(PLUGIN), "version") },
  ];
}

/** Writes package.json's version into the plugin's plugin.json, changing nothing else in it. */
function syncPlugin(): string {
  const version = String(field(read("package.json"), "version"));
  const text = readFileSync(root + PLUGIN, "utf8");
  writeFileSync(root + PLUGIN, text.replace(/("version":\s*)"[^"]*"/, `$1${JSON.stringify(version)}`));
  return version;
}

// Run as a script, from any path to it (a temporary folder can sit behind a symbolic link).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--check")) {
    const all = versions();
    const differ = all.filter((v) => v.version !== all[0]?.version);
    if (differ.length) {
      for (const v of all) console.error(`${v.place}: ${String(v.version)}`);
      console.error("hoop's version numbers differ: run npm version X.Y.Z --no-git-tag-version (docs/RELEASING.md)");
      process.exit(1);
    }
    console.log(`hoop ${String(all[0]?.version)}: package.json, package-lock.json and the plugin agree`);
  } else {
    console.log(`${PLUGIN}: ${syncPlugin()}`);
  }
}
