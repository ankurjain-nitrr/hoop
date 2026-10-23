// Writes the published JSON Schema files for hoop's review and feedback formats, and the field
// tables in docs/FORMATS.md, from the contract. `--check` writes nothing and exits 1 when either differs.
// Usage: tsx scripts/schemas.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Comment, Feedback, Item, ReviewDoc } from "../src/contract.js";

const root = new URL("..", import.meta.url);

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

const schemaOf = (schema: z.ZodType, id: string, title: string) => ({
  $id: `https://github.com/ankurjain-nitrr/hoop/schemas/${id}.schema.json`,
  title,
  ...(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as object),
});

/** The published schema files, by path in the repository. */
export function schemaFiles(): Record<string, string> {
  return {
    "schemas/review.schema.json": `${JSON.stringify(schemaOf(ReviewDoc, "review", "hoop/review@0: a document for review"), null, 2)}\n`,
    "schemas/feedback.schema.json": `${JSON.stringify(schemaOf(Feedback, "feedback", "hoop/feedback@0: a review of a document"), null, 2)}\n`,
  };
}

function typeName(s: JsonSchema): string {
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (s.enum) return s.enum.map((v) => `\`${String(v)}\``).join(", ");
  if (s.anyOf) return s.anyOf.map(typeName).join(" or ");
  if (s.type === "array") return `list of ${s.items ? typeName(s.items) : "values"}`;
  return Array.isArray(s.type) ? s.type.join(" or ") : (s.type ?? "value");
}

/** A markdown table of a schema's fields: name, type, whether it's required, and what it means. */
function table(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const required = new Set(json.required ?? []);
  const rows = Object.entries(json.properties ?? {}).map(
    ([name, s]) =>
      `| \`${name}\` | ${typeName(s).replace(/\|/g, "\\|")} | ${required.has(name) ? "yes" : "no"} | ${(s.description ?? "").replace(/\|/g, "\\|")}. |`,
  );
  return ["| Field | Type | Required | Meaning |", "|---|---|---|---|", ...rows].join("\n");
}

const TABLES: Record<string, z.ZodType> = { review: ReviewDoc, item: Item, feedback: Feedback, comment: Comment };

/** A document with each marked field table regenerated. */
export function withTables(doc: string): string {
  let out = doc;
  for (const [name, schema] of Object.entries(TABLES)) {
    const open = `<!-- fields:${name} -->`,
      close = `<!-- /fields:${name} -->`;
    const a = out.indexOf(open),
      b = out.indexOf(close);
    if (a < 0 || b < a) continue;
    out = `${out.slice(0, a + open.length)}\n${table(schema)}\n${out.slice(b)}`;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const want = { ...schemaFiles(), "docs/FORMATS.md": withTables(readFileSync(new URL("docs/FORMATS.md", root), "utf8")) };
  let stale = 0;
  for (const [path, text] of Object.entries(want)) {
    let now = "";
    try {
      now = readFileSync(new URL(path, root), "utf8");
    } catch {}
    if (now === text) continue;
    stale++;
    if (check) console.log(`${path} is out of date; run npx tsx scripts/schemas.ts`);
    else writeFileSync(new URL(path, root), text);
  }
  process.exit(check && stale ? 1 : 0);
}
