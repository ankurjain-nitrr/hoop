import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./util.js";

type IndexFile = { format: 1; reviews: Record<string, string> };

/**
 * The index in the hoop home folder, `index.json`: each review ID kept in a session's folder, with
 * the `.hoop` folder that holds it. A review the index doesn't name lives in the home folder's
 * `reviews/`. It lets one pages process serve every session's reviews, and keeps links valid.
 */
export class Registry {
  private cache?: { key: string; reviews: Record<string, string> };

  constructor(readonly home: string) {}

  private get path() {
    return join(this.home, "index.json");
  }

  /** Every indexed review ID with its `.hoop` folder, read again only when the file changed. */
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
        const v = JSON.parse(readFileSync(this.path, "utf8")) as Partial<IndexFile>;
        if (v && typeof v.reviews === "object" && v.reviews) reviews = v.reviews;
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

  /** Records where a review lives. */
  set(id: string, folder: string): void {
    this.change((reviews) => {
      reviews[id] = folder;
    });
  }

  /** Removes the entries of reviews that are gone. */
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
    writeAtomic(this.path, `${JSON.stringify({ format: 1, reviews } satisfies IndexFile, null, 2)}\n`);
    this.cache = undefined;
  }
}
