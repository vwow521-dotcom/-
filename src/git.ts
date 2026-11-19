// Thin wrapper over the git CLI in the target project.
import { execFile } from "node:child_process";

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (err ? stderr || err.message : stdout).toString().trim() }),
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

export type CommitResult = { sha: string } | { error: string } | { skipped: string };

/** Stage everything and commit. No changes → skipped (no empty commits). */
export async function commitAll(cwd: string, subject: string, body: string): Promise<CommitResult> {
  if (!(await isRepo(cwd))) return { skipped: "不是 git 仓库" };
  const add = await git(cwd, ["add", "-A"]);
  if (!add.ok) return { error: "git add 失败：" + add.out };
  const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (staged.ok) return { skipped: "没有文件改动" };
  const c = await git(cwd, ["commit", "-m", subject, "-m", body]);
  if (!c.ok) return { error: "git commit 失败：" + c.out };
  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  return sha.ok ? { sha: sha.out } : { error: sha.out };
}

export async function show(cwd: string, sha: string) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return "无效的提交号";
  const r = await git(cwd, ["show", "--stat", "--patch", "--format=fuller", sha]);
  return r.out;
}
