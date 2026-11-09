// Patterns that belong to one module each: a copy anywhere else re-derives what that module owns, so
// `npm run debt` counts each one outside its owner (and outside ALLOWED) as debt. Run this file to
// list them: tsx scripts/banned.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Rule = {
  name: string;
  /** What to use instead, as the report says it. */
  use: string;
  pattern: RegExp;
  /** The folders the rule reads, under the checkout. */
  dirs: string[];
  /** The files the pattern belongs to, which may use it. */
  owners: string[];
};

/** The web modules the server may import: the shared grammar, status, link, line and activity modules. */
const SHARED_WEB = ["blocks", "status", "links", "doc-lines", "activity"];

export const RULES: Rule[] = [
  {
    name: "raw JSON file read",
    use: "readJson or tryReadJson (src/util.ts)",
    pattern: /JSON\.parse\(\s*readFileSync\(/,
    dirs: ["src"],
    owners: ["src/util.ts"],
  },
  {
    name: "hand-built ID",
    use: "newId or childId (src/ids.ts)",
    pattern: /`(?:rv|th|ed|bt|st|ac)_\$\{|["'](?:rv|th|ed|bt|st|ac)_["']\s*\+/,
    dirs: ["src", "web"],
    owners: ["src/ids.ts"],
  },
  {
    name: "review ID regex",
    use: "REVIEW_ID_PATTERN or isReviewId (src/ids.ts), or web/links.js",
    pattern: /rv_\[a-z0-9\]/,
    dirs: ["src", "web"],
    owners: ["src/ids.ts", "web/links.js"],
  },
  {
    name: "heading regex",
    use: "ATX, HEADING, HEADING_MARK or headingText (web/blocks.js)",
    pattern: /#\{1,6\}/,
    dirs: ["src", "web"],
    owners: ["web/blocks.js"],
  },
  {
    name: "fence or Mermaid regex",
    use: "FENCE, MERMAID or isDiagram (web/blocks.js)",
    pattern: /\(```\|~~~\)|mermaid\\s/,
    dirs: ["src", "web"],
    owners: ["web/blocks.js"],
  },
  {
    name: "raw fetch in a page",
    use: "api, post or peek (web/api.js)",
    pattern: /\bfetch\(/,
    dirs: ["web"],
    owners: ["web/api.js"],
  },
  {
    name: "server importing a page module",
    use: `only the shared web modules (${SHARED_WEB.map((m) => `web/${m}.js`).join(", ")})`,
    pattern: new RegExp(`from "\\.\\./web/(?!(?:${SHARED_WEB.join("|")})\\.js")`),
    dirs: ["src"],
    owners: [],
  },
];

/**
 * Today's uses outside an owner that are meant, by rule and file, with how many and why. A new use
 * goes in its owner, or here with its reason.
 */
export const ALLOWED: Record<string, Record<string, { count: number; why: string }>> = {
  "raw JSON file read": {
    "src/review-gate.ts": { count: 2, why: "a feedback file that doesn't parse counts as reviewed, so a broken folder never refuses a write" },
  },
  "review ID regex": {
    "web/review.js": { count: 1, why: "the #ask-<review ID> hash a quick question's link carries" },
    "web/drafts.js": { count: 1, why: "the hoop:<review ID>:drafts key of drafts kept in the browser" },
  },
  "heading regex": {
    "src/ops.ts": { count: 1, why: "a build's suggested headings, as Claude writes them" },
    "src/web.ts": { count: 1, why: "a pull request description's lines on Home, which isn't a review document" },
  },
  "fence or Mermaid regex": {
    "web/inline.js": { count: 1, why: "a closing fence line on its own, without FENCE's indent limit" },
  },
};

export type Finding = { rule: string; file: string; line: number; text: string };

/** Every use of a rule's pattern outside its owners, in `files` (path relative to the checkout, and text). */
export function findBanned(files: { path: string; text: string }[], rules = RULES): Finding[] {
  const found: Finding[] = [];
  for (const r of rules)
    for (const f of files) {
      if (!r.dirs.some((d) => f.path.startsWith(`${d}/`)) || r.owners.includes(f.path)) continue;
      f.text.split("\n").forEach((text, i) => {
        if (r.pattern.test(text)) found.push({ rule: r.name, file: f.path, line: i + 1, text: text.trim() });
      });
    }
  return found;
}

/** The findings beyond what ALLOWED allows in each file, by rule. */
export function unallowed(found: Finding[], allowed = ALLOWED): Finding[] {
  const seen = new Map<string, number>();
  return found.filter((f) => {
    const key = `${f.rule}\u0000${f.file}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n > (allowed[f.rule]?.[f.file]?.count ?? 0);
  });
}

/** The source files the rules read, under the checkout at `dir`. */
export function sources(dir: string): { path: string; text: string }[] {
  const dirs = [...new Set(RULES.flatMap((r) => r.dirs))];
  return dirs.flatMap((d) =>
    readdirSync(join(dir, d), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts") && !f.startsWith("vendor/"))
      .map((f) => ({ path: `${d}/${f}`, text: readFileSync(join(dir, d, f), "utf8") })),
  );
}

/** The count `npm run debt` keeps: uses of a banned pattern outside its owner and ALLOWED. */
export const bannedCounts = (dir: string) => ({ bannedPatterns: unallowed(findBanned(sources(dir))).length });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const left = unallowed(findBanned(sources(root)));
  const use = new Map(RULES.map((r) => [r.name, r.use]));
  for (const f of left) console.log(`${f.file}:${f.line}: ${f.rule}; use ${use.get(f.rule)}\n  ${f.text}`);
  console.log(left.length ? `${left.length} banned pattern${left.length === 1 ? "" : "s"} outside their owners` : "No banned patterns outside their owners");
  process.exit(left.length ? 1 : 0);
}
