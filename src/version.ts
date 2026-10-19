import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder hoop runs from: the checkout under tsx, the package folder under `dist`. */
export const ownInstall = () => fileURLToPath(new URL("..", import.meta.url));

/** An install's release from its `package.json`, or undefined when the install is gone. */
export function release(install: string): string | undefined {
  try {
    const version = JSON.parse(readFileSync(join(install, "package.json"), "utf8")).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

const CODE_DIRS = ["src", "dist", "web"];

/**
 * Names an install's code by each file's path, size and modified time, without reading contents,
 * so a page load can afford it. Undefined when the install is gone.
 */
export function codeId(install: string): string | undefined {
  if (release(install) === undefined) return undefined;
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) walk(path);
      else hash.update(`${relative(install, path)}\0${st.size}\0${st.mtimeMs}\n`);
    }
  };
  for (const dir of CODE_DIRS) walk(join(install, dir));
  return hash.digest("hex").slice(0, 12);
}

const parts = (r: string | undefined) => (r && /^\d+(\.\d+)*$/.test(r) ? r.split(".").map(Number) : undefined);

/** True when release `a` is newer than `b`. A release that doesn't parse never compares as newer or older. */
export function isNewer(a: string | undefined, b: string | undefined): boolean {
  const x = parts(a), y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}
