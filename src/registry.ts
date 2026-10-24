import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./util.js";

/** What an index keeps: reviews (`index.json`) or action items (`actions-index.json`). */
export type IndexKind = "reviews" | "actions";

/**
 * An index in the hoop home folder: each review ID (`index.json`), or action item ID
 * (`actions-index.json`), kept in a session's folder, with the `.hoop` folder that holds it. One the
 * index doesn't name lives in the home folder's `reviews/` or `actions/`. It lets one pages process
 * serve every session's reviews and action items, and keeps links valid.
 */
export class Registry {
  private cache?: { key: string; reviews: Record<string, string> };

  constructor(
    readonly home: string,
    private readonly kind: IndexKind = "reviews",
  ) {}

  private get path() {
    return join(this.home, this.kind === "reviews" ? "index.json" : "actions-index.json");
  }

  /** Every indexed ID with its `.hoop` folder, read again only when the file changed. */
  all(): Record<string, string> {
    let key: string;
    try {
      const st = statSync(this.path);
      key = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return {};
    }
    if (this.cache?.key !== key) {
      let reviews: Record<string, string> = {};
      try {
        const v = JSON.parse(readFileSync(this.path, "utf8"))?.[this.kind];
        if (v && typeof v === "object") reviews = v;
      } catch {
        /* unreadable: no entries */
      }
      this.cache = { key, reviews };
    }
    return this.cache.reviews;
  }

  folderOf(id: string): string | undefined {
    const f = this.all()[id];
    return typeof f === "string" ? f : undefined;
  }

  /** Records where a review or action item lives. */
  set(id: string, folder: string): void {
    this.change((reviews) => {
      reviews[id] = folder;
    });
  }

  /** Removes the entries of reviews or action items that are gone. */
  drop(ids: string[]): void {
    if (ids.length)
      this.change((reviews) => {
        for (const id of ids) delete reviews[id];
      });
  }

  private change(fn: (reviews: Record<string, string>) => void): void {
    this.cache = undefined;
    const reviews = { ...this.all() };
    fn(reviews);
    writeAtomic(this.path, `${JSON.stringify({ format: 1, [this.kind]: reviews }, null, 2)}\n`);
    this.cache = undefined;
  }
}
