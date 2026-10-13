import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { addItem, readTracker, setCells } from "../src/tracker.js";
import { gatedChanges } from "../src/sequence.js";
import { Store } from "../src/store.js";
import { tempHome } from "./helpers.js";

const SAMPLE = `# Tracker

Notes before the table | with a pipe.

| ID | Parent | Type | Title | Status | Phase |
|---|---|---|---|---|---|
| CR-9 | | epic | An epic | in progress | build |
| ST-1 | CR-9 | story | A story | todo | |
| T-1 | ST-1 | task | A task with a \\| pipe | todo | |
| S-1 | T-1 | sub-task | A sub-task | todo | |
| B-1 | CR-9 | bug | A bug | done | |
| X-1 | NOPE | task | Orphan | todo | |

Text after.
`;
const file = (text = SAMPLE) => { const p = join(tempHome(), "TRACKER.md"); writeFileSync(p, text); return p; };
const shape = (nodes: ReturnType<typeof readTracker>["tree"]): unknown => nodes.map((n) => (n.children.length ? [n.item.id, shape(n.children)] : n.item.id));

test("FR-8: items nest by parent at four levels; an unknown parent is a root; escaped pipes stay in the cell", () => {
  const t = readTracker(file());
  assert.deepEqual(t.columns, ["ID", "Parent", "Type", "Title", "Status", "Phase"]);
  assert.deepEqual(shape(t.tree), [["CR-9", [["ST-1", [["T-1", ["S-1"]]]], "B-1"]], "X-1"]);
  const task = t.items.find((i) => i.id === "T-1")!;
  assert.deepEqual([task.parent, task.type, task.title, task.status, task.phase, task.line], ["ST-1", "task", "A task with a \\| pipe", "todo", undefined, 8]);
  assert.equal(t.items[0]!.phase, "build");
});

test("FR-8: setCells changes only its row; adding a column fills every row; the rest is byte-identical", () => {
  const p = file();
  setCells(p, "T-1", { Status: "in review", Title: "Line one\nline | two" });
  const after = readFileSync(p, "utf8").split("\n"), before = SAMPLE.split("\n");
  assert.deepEqual(after.filter((l, i) => l !== before[i]), ["| T-1 | ST-1 | task | Line one line \\| two | in review | |"]);
  setCells(p, "CR-9", { PR: "#27" });
  const t = readTracker(p);
  assert.deepEqual(t.columns.at(-1), "PR");
  assert.equal(t.items.find((i) => i.id === "CR-9")!.cells.PR, "#27");
  assert.equal(readFileSync(p, "utf8").split("\n")[7], "| ST-1 | CR-9 | story | A story | todo | | |");
  assert.match(readFileSync(p, "utf8"), /^# Tracker\n\nNotes before the table \| with a pipe\.\n/);
  assert.throws(() => setCells(p, "T-99", { Status: "x" }), /no item T-99/);
});

test("FR-8: addItem inserts after an item's subtree, refuses duplicates, and the tree updates", () => {
  const p = file();
  addItem(p, { ID: "T-2", Parent: "ST-1", Type: "task", Title: "Second", Status: "todo" }, { after: "ST-1" });
  addItem(p, { ID: "ST-2", Parent: "CR-9", Type: "story", Title: "End" });
  const t = readTracker(p);
  assert.deepEqual(t.items.map((i) => i.id), ["CR-9", "ST-1", "T-1", "S-1", "T-2", "B-1", "X-1", "ST-2"]);
  assert.deepEqual(shape(t.tree), [["CR-9", [["ST-1", [["T-1", ["S-1"]], "T-2"]], "B-1", "ST-2"]], "X-1"]);
  assert.throws(() => addItem(p, { ID: "T-2", Title: "again" }), /already has T-2/);
  assert.throws(() => addItem(p, { ID: "T-3" }, { after: "NONE" }), /no item NONE/);
});

test("HLD risk: a write based on an old read is refused; writes are atomic and keep CRLF", () => {
  const p = file();
  const { hash } = readTracker(p);
  writeFileSync(p, readFileSync(p, "utf8").replace("A bug", "A bug (edited by hand)"));
  assert.throws(() => setCells(p, "B-1", { Status: "todo" }, { base: hash }), /changed since it was read; read it again and retry/);
  setCells(p, "B-1", { Status: "todo" }, { base: readTracker(p).hash });
  assert.match(readFileSync(p, "utf8"), /\| B-1 \| CR-9 \| bug \| A bug \(edited by hand\) \| todo \| \|/);
  assert.deepEqual(readdirSync(join(p, "..")), ["TRACKER.md"]);
  const crlf = file(SAMPLE.replace(/\n/g, "\r\n"));
  setCells(crlf, "S-1", { Status: "done" });
  assert.equal(readFileSync(crlf, "utf8"), SAMPLE.replace(/\n/g, "\r\n").replace("| A sub-task | todo |", "| A sub-task | done |"));
});

test("NFR-2: the project tracker and the CR-2 and CR-3 trackers load; a cycle doesn't lose items", () => {
  for (const f of ["docs/TRACKER.md", "docs/changes/CR-2-heading-spacing/TRACKER.md", "docs/changes/CR-3-devloop-interfaces/TRACKER.md"]) {
    const p = join(tempHome(), "T.md");
    copyFileSync(new URL(`../${f}`, import.meta.url), p);
    const t = readTracker(p);
    assert.ok(t.items.length > 3, f);
    const count = (n: typeof t.tree): number => n.reduce((a, x) => a + 1 + count(x.children), 0);
    assert.equal(count(t.tree), t.items.length, f);
  }
  const cyc = readTracker(file("| ID | Parent | Title |\n|---|---|---|\n| A | B | a |\n| B | A | b |\n"));
  assert.equal(cyc.tree.length + cyc.tree.reduce((a, n) => a + n.children.length, 0), 2);
  assert.throws(() => readTracker(file("# nothing\n")), /no tracker table .* expected a table with ID and Parent columns/);
});

test("FR-1, FR-2, FR-6: a change shows on the tracker at intake; reclassifying and moving update its row", async () => {
  const repo = tempHome(), path = join(repo, "docs", "TRACKER.md");
  mkdirSync(join(repo, "docs", "changes"), { recursive: true });
  writeFileSync(path, SAMPLE);
  const { changes } = gatedChanges(new Store(tempHome()), repo);
  const { id } = changes.create("Queue requests\nmore", { type: "epic", reason: "r" });
  const row = () => readTracker(path).items.find((i) => i.id === id)!;
  assert.deepEqual([row().type, row().title, row().status, row().phase], ["epic", "Queue requests", "queued", "intake"]);
  changes.classify(id, "story", "one capability");
  await changes.moveStep(id, "prd");
  assert.deepEqual([row().type, row().status, row().phase], ["story", "in progress", "prd"]);
  assert.equal(readFileSync(path, "utf8").split("\n").filter((l) => !SAMPLE.includes(l)).length, 1, "only the change's row is new");

  const fresh = tempHome();
  const { changes: c2 } = gatedChanges(new Store(tempHome()), fresh);
  c2.create("x", { type: "bug", reason: "r" });
  assert.deepEqual(readTracker(join(fresh, "docs", "TRACKER.md")).items.map((i) => [i.id, i.type, i.phase]), [["CR-1", "bug", "intake"]]);
});

test("review fixes: CRLF survives an added column and a file without a final newline; alignment is kept; symlinks stay", () => {
  const crlf = file("| ID | Parent |\r\n|:--|--:|\r\n| A | |\r\n\r\nafter\r\n");
  setCells(crlf, "A", { Phase: "build" });
  assert.equal(readFileSync(crlf, "utf8"), "| ID | Parent | Phase |\r\n|:--|--:|---|\r\n| A | | build |\r\n\r\nafter\r\n");
  const bare = file("| ID | Parent | Title |\r\n|---|---|---|\r\n| A | | x |\r\n| B | A | y |");
  setCells(bare, "A", { Title: "z" });
  assert.equal(readFileSync(bare, "utf8"), "| ID | Parent | Title |\r\n|---|---|---|\r\n| A | | z |\r\n| B | A | y |");
  addItem(bare, { ID: "C", Parent: "A", Title: "w" });
  assert.equal(readFileSync(bare, "utf8"), "| ID | Parent | Title |\r\n|---|---|---|\r\n| A | | z |\r\n| B | A | y |\r\n| C | A | w |");
  const target = file(), link = join(tempHome(), "LINK.md");
  symlinkSync(target, link);
  setCells(link, "B-1", { Status: "todo" });
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.match(readFileSync(target, "utf8"), /\| B-1 \| CR-9 \| bug \| A bug \| todo \|/);
});

test("review fixes: a tracker that can't be updated doesn't fail a change that was saved", async () => {
  const repo = tempHome();
  mkdirSync(join(repo, "docs", "changes"), { recursive: true });
  writeFileSync(join(repo, "docs", "TRACKER.md"), "| ID | Title |\n|---|---|\n");
  const { changes } = gatedChanges(new Store(tempHome()), repo);
  const { id } = changes.create("x", { type: "task", reason: "r" });
  await changes.moveStep(id, "prd");
  assert.equal(changes.step(id), "prd");
});
