import { execFile } from "node:child_process";
import type { Feedback, ReviewDoc } from "./contract.js";
import { readCheckboxAnswers, renderMarkdown, renderPrBody } from "./render.js";

/** Runs `gh` with args (and optional stdin) and returns stdout. Uses gh's own login (NFR-5). */
export type GhRunner = (args: string[], opts?: { cwd?: string; input?: string }) => Promise<string>;

export const ghCli: GhRunner = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile("gh", args, { cwd: opts.cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${(stderr || err.message).trim()}`)) : resolve(stdout),
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

/** `commits` maps each pushed commit sha to the revision it carries, to anchor comments. */
/** `own_comments` are comments hoop posted (Claude's replies), which sync must not read as reviews. */
export type PrRef = { repo: string; pr: number; branch: string; url: string; commits?: Record<string, number>; own_comments?: number[] };

type GhComment = {
  id: number; body: string; path: string; line: number | null; original_line: number | null;
  original_commit_id: string; in_reply_to_id?: number; pull_request_review_id: number | null;
  user: { login: string }; created_at: string;
};
type GhReview = { id: number; state: string; body: string | null; user: { login: string }; submitted_at: string; commit_id: string };

export type PrState = { feedback: Feedback[]; merged: boolean; merged_at?: string; closed: boolean; answers: { item: string; choice: string }[] };

const VERDICT: Record<string, Feedback["verdict"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "comment" };

export class GitHub {
  constructor(private readonly gh: GhRunner = ghCli) {}

  async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const args = ["api", "--method", method, path, "-H", "Accept: application/vnd.github+json"];
    const out = await this.gh(body === undefined ? args : [...args, "--input", "-"], body === undefined ? {} : { input: JSON.stringify(body) });
    return (out.trim() ? JSON.parse(out) : {}) as T;
  }

  /** owner/name and default branch of the repo checked out at dir. */
  async repoAt(dir: string): Promise<{ repo: string; base: string }> {
    const out = JSON.parse(await this.gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { cwd: dir }));
    return { repo: out.nameWithOwner, base: out.defaultBranchRef.name };
  }

  /** Commits decisions/<slug>.json and .md on top of `parent` in one commit. */
  private async commitFiles(repo: string, parent: string, doc: ReviewDoc, revision: number, message: string) {
    const parentCommit = await this.api<{ tree: { sha: string } }>("GET", `repos/${repo}/git/commits/${parent}`);
    const json = JSON.stringify({ ...doc, revision, channel: "github" }, null, 2) + "\n";
    const tree = await this.api<{ sha: string }>("POST", `repos/${repo}/git/trees`, {
      base_tree: parentCommit.tree.sha,
      tree: [
        { path: `decisions/${doc.slug}.json`, mode: "100644", type: "blob", content: json },
        { path: `decisions/${doc.slug}.md`, mode: "100644", type: "blob", content: renderMarkdown(doc, revision).markdown },
      ],
    });
    const commit = await this.api<{ sha: string }>("POST", `repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [parent] });
    return commit.sha;
  }

  /** Opens the decision PR: branch hoop/<slug> from the default branch, one commit, TL;DR and question checkboxes (FR-12). */
  async open(dir: string, doc: ReviewDoc): Promise<PrRef> {
    const { repo, base } = await this.repoAt(dir);
    let branch = `hoop/${doc.slug}`;
    const head = await this.api<{ object: { sha: string } }>("GET", `repos/${repo}/git/ref/heads/${base}`);
    const sha = await this.commitFiles(repo, head.object.sha, doc, 1, `Propose ${doc.title} (rev 1)`);
    // A branch left from an earlier decision on the same slug gets a numeric suffix.
    for (let n = 1; ; n++) {
      branch = n === 1 ? `hoop/${doc.slug}` : `hoop/${doc.slug}-${n}`;
      try {
        await this.api("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
        break;
      } catch (err) {
        if (n >= 20 || !/Reference already exists/i.test(String((err as Error).message))) throw err;
      }
    }
    const pr = await this.api<{ number: number; html_url: string }>("POST", `repos/${repo}/pulls`, {
      title: `decision: ${doc.title}`, head: branch, base, body: renderPrBody(doc, 1),
    });
    return { repo, pr: pr.number, branch, url: pr.html_url, commits: { [sha]: 1 } };
  }

  /** Pushes revision n as a new commit on the PR branch and refreshes the description, keeping ticked answers (FR-14). */
  async revise(ref: PrRef, doc: ReviewDoc, revision: number): Promise<PrRef> {
    const head = await this.api<{ object: { sha: string } }>("GET", `repos/${ref.repo}/git/ref/heads/${ref.branch}`);
    const sha = await this.commitFiles(ref.repo, head.object.sha, doc, revision, `Revise ${doc.title} (rev ${revision})`);
    await this.api("PATCH", `repos/${ref.repo}/git/refs/heads/${ref.branch}`, { sha });
    const pr = await this.api<{ body: string | null }>("GET", `repos/${ref.repo}/pulls/${ref.pr}`);
    await this.api("PATCH", `repos/${ref.repo}/pulls/${ref.pr}`, { body: renderPrBody(doc, revision, readCheckboxAnswers(pr.body ?? "")) });
    return { ...ref, commits: { ...ref.commits, [sha]: revision } };
  }

  /**
   * Reads the PR's reviews into feedback documents (FR-13): one per submitted GitHub review, with its
   * line comments on decisions/<slug>.md mapped back to item and line through the rendered line map
   * of the revision the comment was made on; GitHub suggestions become `suggestion`; replies join
   * their thread (gh_<root id>); ticked description checkboxes become answers.
   */
  async sync(ref: PrRef, reviewId: string, revisions: ReviewDoc[]): Promise<PrState> {
    const base = `repos/${ref.repo}/pulls/${ref.pr}`;
    const [pr, reviews, comments, resolved] = await Promise.all([
      this.api<{ body: string | null; merged: boolean; merged_at?: string | null; state: string }>("GET", base),
      this.api<GhReview[]>("GET", `${base}/reviews?per_page=100`),
      this.api<GhComment[]>("GET", `${base}/comments?per_page=100`),
      this.resolvedThreads(ref),
    ]);
    const latest = revisions.length;
    const revisionOf = (sha: string) => ref.commits?.[sha] ?? latest;
    const paths = new Set(revisions.map((d) => `decisions/${d.slug}.md`));
    const own = new Set(ref.own_comments ?? []);
    const maps = revisions.map((d, i) => renderMarkdown(d, i + 1));
    const roots = new Map(comments.map((c) => [c.id, c]));
    const rootOf = (c: GhComment): GhComment => (c.in_reply_to_id && roots.get(c.in_reply_to_id) ? rootOf(roots.get(c.in_reply_to_id)!) : c);

    const anchor = (c: GhComment) => {
      const root = rootOf(c);
      const rev = revisionOf(root.original_commit_id);
      const map = maps[rev - 1]?.lineMap ?? {};
      const at = root.original_line ?? root.line ?? 0;
      // A comment on a heading or blank line belongs to the next item line below it.
      for (let n = at; n <= at + 3; n++) if (map[n]) return { ...map[n]!, rev, mdLine: n };
      return undefined;
    };

    const feedback: Feedback[] = reviews
      .filter((r) => VERDICT[r.state])
      .flatMap((r) => {
        const all = comments.filter((c) => c.pull_request_review_id === r.id && !own.has(c.id));
        // A review that only wraps hoop's own replies is not reviewer feedback.
        if (!all.length && !r.body?.trim() && comments.some((c) => c.pull_request_review_id === r.id)) return [];
        const unplaced: string[] = [];
        const mapped = all.flatMap((c) => {
          const a = paths.has(c.path) ? anchor(c) : undefined;
          if (!a) {
            unplaced.push(`On ${c.path}${c.original_line ? ` line ${c.original_line}` : ""}: ${c.body.trim()}`);
            return [];
          }
          const sugg = c.body.match(/```suggestion\r?\n([\s\S]*?)```/);
          const text = c.body.replace(/```suggestion\r?\n[\s\S]*?```/, "").trim();
          const suggestion = sugg ? sugg[1]!.replace(/\n$/, "").replace(new RegExp(`^${a.item} · `), "") : undefined;
          return [{ thread: `gh_${rootOf(c).id}`, item: a.item, line: a.line, ...(text ? { body: text } : {}), ...(suggestion !== undefined ? { suggestion } : {}) }];
        });
        // Comments that don't sit on an item line (title, TL;DR, the .json) go into the summary.
        const summary = [r.body?.trim(), ...unplaced].filter(Boolean).join("\n\n");
        return [{
          schema: "hoop/feedback@0" as const, review_id: reviewId, revision: revisionOf(r.commit_id),
          verdict: VERDICT[r.state]!, ...(summary ? { summary } : {}),
          comments: mapped, answers: [], resolved_threads: [], viewed: [],
          reviewer: r.user.login, at: r.submitted_at,
          source: { channel: "github" as const, pr: ref.pr, review_id: r.id, comment_ids: all.map((c) => c.id) },
        }];
      });

    // Ticked boxes live in the description, not in a review: they're reported as `answers`, and also
    // attached to the latest review on the latest revision, but never count as a review themselves.
    const answers = Object.entries(readCheckboxAnswers(pr.body ?? "")).map(([item, choice]) => ({ item, choice }));
    const last = [...feedback].reverse().find((f) => f.revision === latest);
    if (last) Object.assign(last, { answers, resolved_threads: resolved.map((id) => `gh_${id}`) });
    return { feedback, merged: pr.merged, ...(pr.merged_at ? { merged_at: pr.merged_at } : {}), closed: pr.state === "closed" && !pr.merged, answers };
  }

  /** Root comment ids of resolved review threads (GraphQL; REST has no resolved state). */
  private async resolvedThreads(ref: PrRef): Promise<number[]> {
    const [owner, name] = ref.repo.split("/");
    const query = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{databaseId}}}}}}}`;
    try {
      const out = JSON.parse(await this.gh(["api", "graphql", "-f", `query=${query}`, "-F", `o=${owner}`, "-F", `n=${name}`, "-F", `p=${ref.pr}`]));
      return out.data.repository.pullRequest.reviewThreads.nodes
        .filter((t: { isResolved: boolean }) => t.isResolved)
        .map((t: { comments: { nodes: { databaseId: number }[] } }) => t.comments.nodes[0]?.databaseId)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Replies in a review thread on the PR (FR-11). */
  async reply(ref: PrRef, rootCommentId: number, body: string): Promise<number> {
    const c = await this.api<{ id: number }>("POST", `repos/${ref.repo}/pulls/${ref.pr}/comments/${rootCommentId}/replies`, { body });
    return c.id;
  }
}
