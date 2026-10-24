import { createInterface } from "node:readline";
import { validSession } from "./owner.js";
import { Store, type ReviewMeta } from "./store.js";
import { HoopError } from "./util.js";

export const CLEAR_USAGE = "clear <review_id> [--yes] | clear --session <session_id> [--yes]";

/** Asks a yes-or-no question on the terminal. */
function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    }),
  );
}

/** The reviews `hoop clear` deletes for its arguments, or a refusal for arguments it doesn't take. */
function targets(argv: string[], store: Store): { reviews: ReviewMeta[]; scope: string } {
  const usage = () => new HoopError(`usage: hoop ${CLEAR_USAGE}`);
  const rest = argv.filter((a) => a !== "--yes");
  if (rest[0] === "--session") {
    if (rest.length !== 2) throw usage();
    const session = validSession(rest[1]);
    if (!session) throw new HoopError(`invalid session ID ${rest[1]}`);
    return { reviews: store.list().filter((m) => m.owner?.session === session), scope: `session ${session}` };
  }
  if (rest.length !== 1 || rest[0]!.startsWith("--")) throw usage();
  try {
    return { reviews: [store.meta(rest[0]!)], scope: rest[0]! };
  } catch {
    throw new HoopError(`no review ${rest[0]}`);
  }
}

/**
 * `hoop clear`: deletes one review, or every review of one Claude Code session, for good. hoop
 * never deletes a review by itself. On a terminal it asks first; otherwise it needs --yes. Returns
 * the exit code. `remove` deletes the reviews: the command sends them to the pages process.
 */
export async function clearReviews(
  argv: string[],
  store = new Store(),
  remove: (ids: string[]) => Promise<unknown> = async (ids) => {
    for (const id of ids) store.remove(id);
  },
): Promise<number> {
  const { reviews, scope } = targets(argv, store);
  if (!reviews.length) {
    process.stdout.write(`hoop: no reviews to clear for ${scope}\n`);
    return 0;
  }
  const what = reviews.length === 1 ? `review ${reviews[0]!.id} (${reviews[0]!.title})` : `${reviews.length} reviews of ${scope}`;
  if (!argv.includes("--yes")) {
    if (!process.stdin.isTTY) throw new HoopError(`hoop clear deletes ${what} for good; pass --yes to confirm`);
    if (!(await ask(`Delete ${what} for good? [y/N] `))) {
      process.stderr.write("hoop: nothing deleted\n");
      return 1;
    }
  }
  await remove(reviews.map((m) => m.id));
  process.stdout.write(`hoop: cleared ${what}\n`);
  return 0;
}
