// Refuses a code comment that names a change request or a tracker item by its ID.
// Code says what it does now; the history behind it lives in docs/changes/ and git.
// Usage: tsx scripts/comment-guard.ts [file...]; with no files it checks src, web, test and scripts.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const NAMED = /\b(?:CR|B|T)-\d+\b/;
const CODE = /\.(?:ts|js|mjs|css)$/;

/** Each comment in a file, with its line number. */
export function comments(file: string, text: string): { line: number; text: string }[] {
  const lineOf = (pos: number) => text.slice(0, pos).split("\n").length;
  if (file.endsWith(".css")) return [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => ({ line: lineOf(m.index), text: m[0] }));
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const seen = new Map<number, string>();
  const collect = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) seen.set(r.pos, text.slice(r.pos, r.end));
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(source);
  collect(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));
  return [...seen].sort(([a], [b]) => a - b).map(([pos, body]) => ({ line: lineOf(pos), text: body }));
}

/** The comments in a file that name a change request or a tracker item. */
export function findings(file: string, text: string): { line: number; name: string }[] {
  return comments(file, text).flatMap((c) => {
    const m = NAMED.exec(c.text);
    return m ? [{ line: c.line + c.text.slice(0, m.index).split("\n").length - 1, name: m[0] }] : [];
  });
}

function defaultFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "src", "web", "test", "scripts"], { encoding: "utf8" });
  return out.split("\n").filter((f) => CODE.test(f) && !f.startsWith("web/vendor/"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.length > 2 ? process.argv.slice(2).filter((f) => CODE.test(f)) : defaultFiles();
  let count = 0;
  for (const file of files) {
    for (const f of findings(file, readFileSync(file, "utf8"))) {
      console.log(`${file}:${f.line}: a comment names ${f.name}; say what the code does, and keep its history in docs/changes/`);
      count++;
    }
  }
  process.exit(count ? 1 : 0);
}
