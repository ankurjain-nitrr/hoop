// Writes the published JSON Schema files for hoop's review and feedback formats from the contract.
// `--check` writes nothing and exits 1 when a file differs.
// Usage: tsx scripts/schemas.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Feedback, ReviewDoc } from "../src/contract.js";

const root = new URL("..", import.meta.url);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [path, text] of Object.entries(schemaFiles())) {
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
