// Thin wrapper over the git CLI in the target project.
import { execFile } from "node:child_process";

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      // trimEnd only: `git status --porcelain` lines start with a significant space.
      resolve({ ok: !err, out: (err ? stderr || err.message : stdout).toString().trimEnd() }),
    );
  });
}

export async function isRepo(cwd: string) {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.out === "true";
}

export async function dirtyFiles(cwd: string): Promise<string[]> {
  const r = await git(cwd, ["status", "--porcelain"]);
  return r.ok && r.out ? r.out.split("\n") : [];
}

/** Paths (forward slashes, relative to the repo root) with uncommitted changes, including untracked files. */
export async function changedFiles(cwd: string): Promise<string[]> {
  const r = await git(cwd, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"]);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").map((l) => {
    let p = l.slice(3);
    if (p.includes(" -> ")) p = p.split(" -> ")[1];
    return p.replace(/^"|"$/g, "");
  });
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globMatch(glob: string, file: string): boolean {
  const re = glob
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`, "i").test(file);
}

/** Normalise a lease glob: forward slashes, no leading ./, a trailing / means the whole directory. */
export function normGlob(g: string) {
  let x = g.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (x.endsWith("/")) x += "**";
  return x;
}

/** Could some file match both globs? Exact for literal paths; conservative (prefix check) when both have wildcards. */
export function globsOverlap(a: string, b: string): boolean {
  const A = normGlob(a), B = normGlob(b);
  if (globMatch(A, B) || globMatch(B, A)) return true;
  const lit = (g: string) => g.split(/[*?]/)[0].toLowerCase();
  const wa = /[*?]/.test(A), wb = /[*?]/.test(B);
  if (!wa || !wb) return false;
  const pa = lit(A), pb = lit(B);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export type CommitResult = { sha: string } | { error: string } | { skipped: string };

/** Stage everything and commit. No changes → skipped, unless allowEmpty (review conclusions). */
export async function commitAll(cwd: string, subject: string, body: string, opts: { allowEmpty?: boolean } = {}): Promise<CommitResult> {
  if (!(await isRepo(cwd))) return { skipped: "不是 git 仓库" };
  const add = await git(cwd, ["add", "-A"]);
  if (!add.ok) return { error: "git add 失败：" + add.out };
  const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (staged.ok && !opts.allowEmpty) return { skipped: "没有文件改动" };
  const c = await git(cwd, ["commit", ...(staged.ok ? ["--allow-empty"] : []), "-m", subject, "-m", body]);
  if (!c.ok) return { error: "git commit 失败：" + c.out };
  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  return sha.ok ? { sha: sha.out } : { error: sha.out };
}

/** Commit only `paths` (staging their additions and deletions), leaving everything else in the index and
 *  work tree alone. No paths and allowEmpty → an empty commit that ignores whatever else is staged. */
export async function commitPaths(cwd: string, paths: string[], subject: string, body: string, opts: { allowEmpty?: boolean } = {}): Promise<CommitResult> {
  if (!(await isRepo(cwd))) return { skipped: "不是 git 仓库" };
  if (!paths.length) {
    if (!opts.allowEmpty) return { skipped: "本任务范围内没有文件改动" };
    const c = await git(cwd, ["commit", "--only", "--allow-empty", "-m", subject, "-m", body]);
    if (!c.ok) return { error: "git commit 失败：" + c.out };
  } else {
    const add = await git(cwd, ["add", "-A", "--", ...paths]);
    if (!add.ok) return { error: "git add 失败：" + add.out };
    const c = await git(cwd, ["commit", "--only", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-m", subject, "-m", body, "--", ...paths]);
    if (!c.ok) return /nothing to commit|no changes added/i.test(c.out) ? { skipped: "本任务范围内没有文件改动" } : { error: "git commit 失败：" + c.out };
  }
  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  return sha.ok ? { sha: sha.out } : { error: sha.out };
}

export async function show(cwd: string, sha: string) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return "无效的提交号";
  const r = await git(cwd, ["show", "--stat", "--patch", "--format=fuller", sha]);
  return r.out;
}
