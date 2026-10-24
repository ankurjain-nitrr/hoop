// A session for test/writer.test.ts: sends many comments and replies on one review to the pages
// process at once, through the same path as hoop's sessions and commands.
// Usage: tsx test/writer-worker.ts <home> <port> <review_id> <thread> <count> <tag>
import { Remote, clientHoop, runOp } from "../src/remote.js";
import { OPS } from "../src/ops.js";

const [home, port, id, thread, count, tag] = process.argv.slice(2) as [string, string, string, string, string, string];
const hoop = clientHoop({ session: "writer-owner", claude: false }, home);
hoop.remote = new Remote(home, Number(port), { start: false });
const op = (name: string) => OPS.find((o) => o.name === name)!;
await Promise.all(
  Array.from({ length: Number(count) }, (_, i) => [
    runOp(hoop, op("comment"), { review_id: id, item: "DOC", line: 1, body: `${tag} ${i}` }, { actor: "claude" }),
    runOp(hoop, op("reply"), { thread, body: `${tag} reply ${i}` }, { actor: "claude" }),
  ]).flat(),
);
