import { anchorText, inScope, scopeOf, type FieldError, type ReviewDoc } from "./contract.js";
import { audit } from "./audit.js";
import { applyEdit, EditError, narrow, wordStats, type WordStats } from "./edit.js";
import { editable, thread as threadOf } from "./rules.js";
import type { Applied, Proposal, Store } from "./store.js";
import { currentUser, HoopError } from "./util.js";

/**
 * Turns review comments into document changes: reviewers' exact suggestions, and the agent's
 * proposed edits that reviewers accept or reject. Every change is a span edit in a new revision.
 */
export class Materializer {
  constructor(readonly store: Store) {}

  /**
   * Applies a reviewer's exact suggestion (FR-18): replaces just the suggested span in a new
   * revision and marks the thread applied. Everything else in the document is unchanged (FR-22).
   */
  applySuggestion(reviewId: string, thread: string, by = currentUser()): { revision: number; applied: Applied; words: WordStats } {
    const meta = editable(this.store, reviewId, { open: true, github: (m) => `review ${m.id} is reviewed on GitHub; use Commit suggestion there` });
    if (this.store.applied(meta.id).some((a) => a.thread === thread)) throw new HoopError(`thread ${thread} is already applied`);
    const found = threadOf(this.store, meta.id, thread);
    const entry = found?.entries.filter((e) => e.comment.suggestion !== undefined).at(-1);
    if (!found || !entry) throw new HoopError(`thread ${thread} has no suggestion to apply`);
    const { root } = found, rev = entry.revision;
    // The thread's root anchor is authoritative; a reply's own item and line are client-supplied.
    const c = { ...entry.comment, item: root.item, line: root.line, range: entry.comment === root ? root.range : entry.comment.range };
    const doc = this.store.revision(meta.id);
    const now = anchorText(doc, c.item, c.line);
    const then = anchorText(this.store.revision(meta.id, rev), c.item, c.line);
    if (now === undefined || now !== then) throw new HoopError("the text this suggestion was made on has changed; suggest again on the current text");
    const edit = c.range
      ? { item: c.item, line: c.line, start: c.range.start, find: c.range.quote, replace: c.suggestion! }
      : { item: c.item, line: c.line, ...narrow(now, c.suggestion!) };
    if (!edit.find || edit.find === edit.replace) throw new HoopError("the suggestion matches the current text");
    let next: ReviewDoc, located: { start: number; end: number };
    try {
      ({ doc: next, located } = applyEdit(doc, edit));
    } catch (err) {
      if (err instanceof EditError) throw new HoopError(err.message, [{ path: err.field, message: err.message }]);
      throw err;
    }
    const after = this.store.addRevision(meta.id, next);
    this.rebaseProposals(meta.id, c.item, c.line, located, edit.replace, anchorText(next, c.item, c.line)!);
    const applied: Applied = { thread, revision: after.revisions, by, at: new Date().toISOString(), kind: "suggestion", item: c.item, line: c.line, find: edit.find, replace: edit.replace };
    this.store.addApplied(meta.id, applied);
    const words = wordStats(edit.find, edit.replace, now);
    audit("apply_suggestion", { review_id: meta.id, revision: after.revisions, actor: by, thread, ...words });
    return { revision: after.revisions, applied, words };
  }

  /**
   * Claude's edits for an instruction comment (FR-20): span replacements on the latest revision,
   * each inside the thread's scope (a line, a section for heading comments, the document for title
   * and TL;DR comments) and each with a `find` that occurs exactly once in its line. All or nothing.
   */
  proposeEdits(reviewId: string, thread: string, edits: unknown, note?: string): { proposals: Proposal[] } {
    const meta = editable(this.store, reviewId, { open: true, github: (m) => `review ${m.id} is reviewed on GitHub; push a revision instead` });
    const rooted = threadOf(this.store, meta.id, thread);
    if (!rooted) throw new HoopError(`no thread ${thread} in review ${meta.id}`);
    const { root } = rooted;
    if (this.store.applied(meta.id).some((a) => a.thread === thread)) throw new HoopError(`thread ${thread} is already applied`);
    const latest = this.store.revision(meta.id);
    // The comment must still point at what the reviewer saw: the same line text, or the same section.
    if (root.item !== "DOC" && !latest.items.some((i) => i.id === root.item))
      throw new HoopError(`the section this comment is on (${root.item}) no longer exists; reply on the thread instead`);
    if (root.line > 0 && root.item !== "DOC" && anchorText(latest, root.item, root.line) !== anchorText(this.store.revision(meta.id, rooted.revision), root.item, root.line))
      throw new HoopError("the text this comment is on has changed since; reply on the thread instead");
    if (!Array.isArray(edits) || !edits.length) throw new HoopError("edits must be a non-empty array", [{ path: "edits", message: "expected at least one edit" }]);
    const scope = scopeOf(root);
    const doc = this.store.revision(meta.id);
    const errors: FieldError[] = [];
    const located: { i: number; item: string; line: number; find: string; replace: string; start: number; end: number }[] = [];
    edits.forEach((raw, i) => {
      const e = raw as Record<string, unknown>;
      const at = (f: string, message: string) => errors.push({ path: `edits.${i}.${f}`, message });
      if (typeof e?.item !== "string") return at("item", "expected an item id");
      if (!Number.isInteger(e.line) || (e.line as number) < 0) return at("line", "expected a line number (0 for the heading)");
      if (typeof e.find !== "string" || !e.find) return at("find", "expected the exact text to replace");
      if (typeof e.replace !== "string") return at("replace", "expected the replacement text");
      if (e.find === e.replace) return at("replace", "replace is the same as find");
      const edit = { item: e.item, line: e.line as number, find: e.find, replace: e.replace };
      if (!inScope(scope, edit))
        return at("item", scope.kind === "line"
          ? `this comment is on ${scope.item} line ${scope.line}; edits must stay on that line`
          : `this comment covers section ${(scope as { item: string }).item}; edits must stay in it`);
      try {
        const { located: l } = applyEdit(doc, edit);
        located.push({ i, ...edit, start: l.start, end: l.end });
      } catch (err) {
        if (err instanceof EditError) return at(err.field, err.message);
        throw err;
      }
    });
    located.forEach((a, k) => located.slice(k + 1).forEach((b) => {
      if (a.item === b.item && a.line === b.line && a.start < b.end && b.start < a.end)
        errors.push({ path: `edits.${b.i}.find`, message: `overlaps edit ${a.i} on the same text` });
    }));
    if (errors.length) throw new HoopError("invalid edits", errors);
    const existing = this.store.proposals(meta.id);
    const now = new Date().toISOString();
    const proposals: Proposal[] = located.map((l, k) => ({
      id: `ed_${meta.id.slice(3)}_${existing.length + k + 1}`, thread, revision: meta.revisions,
      item: l.item, line: l.line, find: l.find, replace: l.replace, start: l.start, ...(note ? { note } : {}), at: now,
      line_text: anchorText(doc, l.item, l.line)!,
      words: wordStats(l.find, l.replace, anchorText(doc, l.item, l.line)!), status: "proposed",
    }));
    this.store.writeProposals(meta.id, [...existing, ...proposals]);
    audit("propose_edits", {
      review_id: meta.id, revision: meta.revisions, actor: "claude", thread, count: proposals.length,
      large: proposals.filter((p) => p.words.large).length, words_changed: proposals.reduce((n, p) => n + Math.max(p.words.removed, p.words.added), 0),
    });
    return { proposals };
  }

  /** Where a proposed edit sits in the latest revision, or null if its text has changed (stale). */
  editPosition(reviewId: string, p: Proposal): { start: number; end: number } | null {
    const now = anchorText(this.store.revision(reviewId), p.item, p.line);
    if (now === undefined || now !== p.line_text || now.slice(p.start, p.start + p.find.length) !== p.find) return null;
    return { start: p.start, end: p.start + p.find.length };
  }

  /**
   * After a span on a line is applied through hoop, other undecided edits on that line follow it:
   * edits before or after the span keep (or shift) their position; overlapping ones go stale.
   */
  private rebaseProposals(reviewId: string, item: string, line: number, applied: { start: number; end: number }, replace: string, newText: string) {
    const list = this.store.proposals(reviewId);
    const delta = replace.length - (applied.end - applied.start);
    let changed = false;
    for (const p of list) {
      if (p.status !== "proposed" || p.item !== item || p.line !== line) continue;
      const end = p.start + p.find.length;
      if (end <= applied.start) Object.assign(p, { line_text: newText });
      else if (p.start >= applied.end) Object.assign(p, { line_text: newText, start: p.start + delta });
      else continue; // overlaps: its text is gone, so it stays stale
      changed = true;
    }
    if (changed) this.store.writeProposals(reviewId, list);
  }

  /**
   * The reviewer's decision on a proposed edit (FR-21). Accepting applies just that span to the
   * latest revision as a new revision and marks the thread applied; rejecting records it.
   */
  decideEdit(reviewId: string, editId: string, action: "accept" | "reject", by = currentUser()): { proposal: Proposal; revision: number } {
    const meta = editable(this.store, reviewId, { open: true });
    const list = this.store.proposals(meta.id);
    const p = list.find((x) => x.id === editId);
    if (!p) throw new HoopError(`no edit ${editId}`);
    if (p.status !== "proposed") throw new HoopError(`edit ${editId} is already ${p.status}`);
    const decided = { decided_by: by, decided_at: new Date().toISOString() };
    if (action === "reject") {
      Object.assign(p, { status: "rejected" }, decided);
      this.store.writeProposals(meta.id, list);
      audit("decide_edit", { review_id: meta.id, revision: meta.revisions, actor: by, action, edit_id: p.id, large: p.words.large });
      return { proposal: p, revision: meta.revisions };
    }
    const pos = this.editPosition(meta.id, p);
    if (!pos) throw new HoopError(`the text edit ${editId} changes has changed since; ask Claude to propose it again`);
    const { doc } = applyEdit(this.store.revision(meta.id), { item: p.item, line: p.line, find: p.find, replace: p.replace, start: pos.start });
    const after = this.store.addRevision(meta.id, doc);
    Object.assign(p, { status: "accepted", applied_revision: after.revisions }, decided);
    this.store.writeProposals(meta.id, list);
    this.rebaseProposals(meta.id, p.item, p.line, pos, p.replace, anchorText(doc, p.item, p.line)!);
    audit("decide_edit", { review_id: meta.id, revision: after.revisions, actor: by, action, edit_id: p.id, large: p.words.large });
    this.store.addApplied(meta.id, { thread: p.thread, revision: after.revisions, by, at: decided.decided_at, kind: "edit", item: p.item, line: p.line, find: p.find, replace: p.replace, edit_id: p.id });
    return { proposal: p, revision: after.revisions };
  }

}
