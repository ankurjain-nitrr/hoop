import { execFile } from "node:child_process";
import type { ReviewDoc } from "./contract.js";
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

export type PrRef = { repo: string; pr: number; branch: string; url: string };

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
    return { repo, pr: pr.number, branch, url: pr.html_url };
  }

  /** Pushes revision n as a new commit on the PR branch and refreshes the description, keeping ticked answers (FR-14). */
  async revise(ref: PrRef, doc: ReviewDoc, revision: number): Promise<void> {
    const head = await this.api<{ object: { sha: string } }>("GET", `repos/${ref.repo}/git/ref/heads/${ref.branch}`);
    const sha = await this.commitFiles(ref.repo, head.object.sha, doc, revision, `Revise ${doc.title} (rev ${revision})`);
    await this.api("PATCH", `repos/${ref.repo}/git/refs/heads/${ref.branch}`, { sha });
    const pr = await this.api<{ body: string | null }>("GET", `repos/${ref.repo}/pulls/${ref.pr}`);
    await this.api("PATCH", `repos/${ref.repo}/pulls/${ref.pr}`, { body: renderPrBody(doc, revision, readCheckboxAnswers(pr.body ?? "")) });
  }
}
