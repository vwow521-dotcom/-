type Build = { commit?: string | null; dirty?: boolean };
type Verdict = { state: "ok" | "bad" | "info"; text: string };

export async function installedVersion(
  repo: string | undefined,
  main: string | null,
  install: Build,
  built: string,
  request = fetch,
): Promise<Verdict> {
  if (!install.commit) return { state: "info", text: "安装来源的提交未知，无法与 GitHub main 比较" };
  if (!main || !repo) return { state: "info", text: "安装自提交 " + built + "，无法读取 GitHub main" };
  if (install.commit === main) return install.dirty
    ? { state: "info", text: "安装自提交 " + built + "，基于 GitHub main 并带有本地改动" }
    : { state: "ok", text: "安装自提交 " + built + "，与 GitHub main 一致" };

  let status: unknown;
  try {
    const response = await request("https://api.github.com/repos/" + repo + "/compare/" + encodeURIComponent(main) + "..." + encodeURIComponent(install.commit), {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ai-bridge-doctor" },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) status = (await response.json() as { status?: unknown }).status;
  } catch {}
  if (status === "ahead") return { state: "info", text: "安装自提交 " + built + "，安装的版本比 GitHub main 新（尚未合入 main）" };
  if (status === "behind") return { state: "bad", text: "安装自提交 " + built + "，落后于 GitHub main → 运行 ai-bridge update" };
  if (status === "diverged") return { state: "bad", text: "安装自提交 " + built + "，安装版本和 GitHub main 已分叉，请核对两边的提交" };
  return { state: "info", text: "安装自提交 " + built + "，和 GitHub main 不一致，无法判断谁新" };
}
