// ai-bridge command line: install/uninstall client configuration, set up a project, start the daemon, diagnose.
//
//   ai-bridge setup                 configure Claude + Codex to use this installed copy (idempotent)
//   ai-bridge uninstall             remove everything `setup` (and older manual installs) added
//   ai-bridge init <dir>            prepare a project folder (git, bridge.config.yaml)
//   ai-bridge start [dir] [--port]  run the bridge for a project (default: current folder)
//   ai-bridge doctor                check that everything is consistent and current (incl. against GitHub)
//   ai-bridge update [--ref <branch|tag|commit>]
//                                   reinstall from GitHub, then refresh only the clients already configured
//
// Every file change makes a timestamped backup first (<file>.bak-ai-bridge-<time>). `--dry-run` shows changes only.
// `setup --refresh` touches only entries that already exist, so a client you removed on purpose stays removed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installedVersion } from "./diagnostics/github.js";
import { probe } from "./diagnostics/probe.js";
import { products, versionWarning } from "./products/index.js";
import type { ProductCli } from "./products/types.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
const VERSION: string = PKG_JSON.version;
/** "owner/name" from package.json repository, used by `update` and `doctor`. */
const REPO: string | undefined = String(PKG_JSON.repository?.url ?? PKG_JSON.repository ?? "").match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
const BUILD: { commit?: string | null; dirty?: boolean; builtAt?: string } = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG, "dist", "build-info.json"), "utf8"));
  } catch {
    return {};
  }
})();
const short = (c?: string | null) => (c ? c.slice(0, 7) : "未知");
const NODE = process.execPath;
const PROXY = path.join(PKG, "bin", "bridge-mcp.mjs");
const PORT = 7878;
const BASE = (process.env.BRIDGE_URL ?? "http://127.0.0.1:" + PORT).replace(/\/$/, "");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = flag("dry-run");
const REFRESH = flag("refresh");

const ok = (m: string) => console.log("  ✓ " + m);
const bad = (m: string) => console.log("  ✗ " + m);
const info = (m: string) => console.log("  · " + m);

function backup(file: string) {
  if (!fs.existsSync(file) || DRY) return;
  const stamp = new Date().toISOString().replace(/\D/g, "");
  fs.copyFileSync(file, `${file}.bak-ai-bridge-${stamp}`);
}
function writeFile(file: string, content: string, what: string) {
  if (DRY) return info(`[dry-run] 会写入 ${file}（${what}）`);
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  ok(`${what} → ${file}`);
}
function removeFile(file: string, what: string) {
  if (DRY) return info(`[dry-run] 会删除 ${file}（${what}）`);
  backup(file);
  fs.rmSync(file);
  ok(`已删除 ${what}：${file}`);
}

const cli: ProductCli = {
  packageDir: PKG,
  node: NODE,
  proxy: PROXY,
  port: PORT,
  refresh: REFRESH,
  project: opt("project"),
  ok,
  bad,
  info,
  writeFile,
  removeFile,
};

// ---------- commands ----------

function setup() {
  console.log(`协作桥 ${VERSION}（${short(BUILD.commit)}）：${REFRESH ? "刷新已有的客户端配置" : "配置客户端"}（安装位置 ${PKG}）`);
  for (const product of products) product.setup(cli);
  if (REFRESH) return;
  const hints = [
    ...products.flatMap((p) => p.setupHint ? [p.setupHint] : []),
    "Claude 和 Codex 都新开对话（已开的对话还在用旧配置）。",
    "为项目启动协作桥：ai-bridge start <项目目录>",
  ];
  console.log(`
接下来：
${hints.map((hint, i) => `  ${i + 1}. ${hint}`).join("\n")}
  随时运行 ai-bridge doctor 检查配置。`);
}

function uninstall() {
  console.log("协作桥：移除客户端配置");
  for (const product of products) product.uninstall(cli);
  console.log("\n各项目里的 .bridge/ 数据和 bridge.config.yaml 没有动。要移除程序本身：npm uninstall -g ai-bridge");
}

function init() {
  const dir = path.resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  console.log(`协作桥：准备项目 ${dir}`);
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "bridge.config.yaml");
  if (fs.existsSync(cfg)) ok("已有 bridge.config.yaml，保持不变");
  else writeFile(cfg, fs.readFileSync(path.join(PKG, "bridge.config.example.yaml"), "utf8"), "流水线配置 bridge.config.yaml");
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let isRepo = false;
  try {
    isRepo = git("rev-parse", "--is-inside-work-tree") === "true";
  } catch {}
  if (!isRepo) {
    if (DRY) info("[dry-run] 会 git init 并提交 bridge.config.yaml");
    else {
      git("init", "-q", "-b", "main");
      git("add", "bridge.config.yaml");
      git("commit", "-q", "-m", "Initial setup for AI bridge");
      ok("已 git init 并做了初始提交（协作桥的自动提交需要已有的历史）");
    }
  } else {
    let hasCommit = true;
    try {
      git("rev-parse", "HEAD");
    } catch {
      hasCommit = false;
    }
    if (hasCommit) ok("已是 git 仓库");
    else bad("是 git 仓库但还没有任何提交：请先做一个初始提交");
  }
  console.log(`\n启动：ai-bridge start ${dir}`);
}

async function start() {
  const dir = path.resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  process.argv = [process.argv[0], "daemon", "--project", dir, "--port", opt("port") ?? String(PORT)];
  await import("./daemon.js");
}

async function bridgeRunning(): Promise<any | null> {
  try {
    const r = await fetch(BASE + "/api/state", { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Latest commit of `ref` on GitHub, or null when offline / not reachable. */
function remoteCommit(ref: string): string | null {
  if (!REPO) return null;
  try {
    const out = execFileSync("git", ["ls-remote", `https://github.com/${REPO}.git`, ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

async function update() {
  if (!REPO) return bad("package.json 里没有 GitHub 仓库地址，没法从 GitHub 更新");
  const ref = opt("ref") ?? "main";
  const url = `https://github.com/${REPO}.git`;
  console.log(`协作桥 ${VERSION}（${short(BUILD.commit)}）：从 GitHub 更新 ${REPO}#${ref}`);
  const latest = remoteCommit(ref);
  // Compare with the global install, not with this copy: `node bin/ai-bridge.mjs update` from a checkout
  // runs newer code than what is installed.
  let installed: typeof BUILD = {};
  try {
    const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    installed = JSON.parse(fs.readFileSync(path.join(root, "ai-bridge", "dist", "build-info.json"), "utf8"));
  } catch {}
  if (latest && latest === installed.commit && !installed.dirty && !flag("force"))
    return ok(`全局安装已经是 ${ref} 的最新提交 ${short(latest)}（要强制重装加 --force）`);
  // Not `npm install -g github:…`: for a global git install npm runs the clone's dependency install in
  // global mode, so prepare (tsc) fails without its dependencies, and npm has already removed the old copy.
  // Instead: fetch + build in a temp folder, and only touch the global install once a package exists.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-update-"));
  const src = path.join(tmp, "src");
  const steps: [string, string][] = [
    [tmp, `git init -q src`],
    [src, `git fetch -q --depth 1 ${url} ${ref}`],
    [src, "git checkout -q FETCH_HEAD"],
    [src, "npm ci --no-audit --no-fund"], // runs prepare: build + dist/build-info.json
    [src, `npm pack --ignore-scripts --pack-destination "${tmp}"`],
  ];
  if (DRY) {
    steps.forEach(([, c]) => info(`[dry-run] 会运行：${c}`));
    ["npm install -g <打好的包>", "ai-bridge setup --refresh", "ai-bridge doctor"].forEach((c) => info(`[dry-run] 会运行：${c}`));
    return fs.rmSync(tmp, { recursive: true, force: true });
  }
  const running = await bridgeRunning();
  // Drop npm settings inherited from an outer `npm run` / `npm -g` so the build installs locally.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_(global|location|prefix)$/i.test(k)));
  const run = (cwd: string, c: string) => {
    console.log(`\n$ ${c}`);
    execSync(c, { cwd, stdio: "inherit", env });
  };
  try {
    for (const [cwd, c] of steps) run(cwd, c);
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack 没有产出安装包");
    // Shell-run so npm.cmd and the freshly installed ai-bridge shim are found; setup/doctor run the new code.
    run(tmp, `npm install -g "${path.join(tmp, tgz)}"`);
    run(tmp, "ai-bridge setup --refresh");
    run(tmp, "ai-bridge doctor");
  } catch {
    return bad("更新中断了，上面是出错的输出（全局安装只在最后一步才会被替换）");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("\n更新完成。Claude 和 Codex 新开的对话会用新版本（已开的对话还在用旧的转接程序）。");
  if (running) console.log(`桥正在为 ${running.project} 运行，还是旧代码：停掉后重新 ai-bridge start 一次。`);
}

function proxyResponds(): Promise<string | null> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    delete env.CLAUDE_CODE_MESSAGING_TOKEN;
    const p = spawn(NODE, [PROXY], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
    let out = "";
    const done = (r: string | null) => {
      clearTimeout(timer);
      p.kill();
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 8000);
    p.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        try {
          const j = JSON.parse(line);
          if (j.id === 2) done((j.result?.tools ?? []).map((t: any) => t.name).join(","));
        } catch {}
      }
    });
    const send = (o: object) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-bridge-doctor", version: VERSION } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    }, 300);
  });
}

async function doctor() {
  console.log(`协作桥 ${VERSION} 体检（安装位置 ${PKG}）`);
  const print = { ok, bad, info };
  if (flag("probe")) {
    for (const check of await probe(bridgeRunning)) print[check.state](check.text);
    return;
  }
  const built = `${short(BUILD.commit)}${BUILD.dirty ? "，构建时有未提交改动" : ""}${BUILD.builtAt ? `，构建于 ${BUILD.builtAt.slice(0, 16).replace("T", " ")}` : ""}`;
  const install = await installedVersion(REPO, BUILD.commit ? remoteCommit("main") : null, BUILD, built);
  print[install.state](install.text);
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}：需要 22.13 或更新（内置 SQLite）`);

  const versions = await Promise.all(products.map((product) => product.detectVersion()));
  for (const [i, product] of products.entries()) {
    product.doctor(cli);
    const version = versions[i];
    const warning = versionWarning(product, version);
    const detail = product.label + " 版本 " + version;
    if (warning) {
      const line = detail + " · " + warning;
      info(process.stdout.isTTY ? "\x1b[33m" + line + "\x1b[0m" : line);
    } else if (version === "unknown") info(detail);
    else ok(detail + "（门铃已验证）");
  }

  const tools = await proxyResponds();
  if (tools === null) bad("转接程序没有响应");
  else if (tools.includes("fetch_inbox")) ok("转接程序正常，桥在运行，工具齐全");
  else ok("转接程序正常（桥没在运行，所以只有占位工具；ai-bridge start <项目> 后自动切换）");

  const s = await bridgeRunning();
  if (s) info(`桥正在运行：项目 ${s.project}，成员 ${s.agents.map((a: any) => `${a.id}=${a.status}`).join("、")}`);
  else info("桥没有在 " + BASE + " 运行");
}

function help() {
  console.log(`ai-bridge ${VERSION}

  ai-bridge setup                 配置 Claude 和 Codex 使用本安装（可反复运行）
  ai-bridge uninstall             移除 setup 加的所有配置（也会清理旧的手动配置）
  ai-bridge init <目录>           准备一个项目：bridge.config.yaml、git
  ai-bridge start [目录] [--port 7878]
                                  为项目启动协作桥（面板 http://127.0.0.1:7878/）
  ai-bridge doctor                检查配置是否一致、安装是否和 GitHub 上的最新版一致
  ai-bridge doctor --probe        只读检查门铃命令、数据格式和代理套接字报告
  ai-bridge update [--ref <分支|标签|提交>] [--force]
                                  从 GitHub 重新安装，然后只刷新已经配置了 bridge 的客户端
  ai-bridge setup --refresh       只更新已有的配置，不新增（update 会自动调用）

  通用选项：--dry-run 只显示会做什么，不改文件。`);
}

const cmd = args[0];
switch (cmd) {
  case "setup":
  case "install":
    setup();
    break;
  case "uninstall":
    uninstall();
    break;
  case "init":
    init();
    break;
  case "start":
    await start();
    break;
  case "doctor":
    await doctor();
    break;
  case "update":
  case "upgrade":
    await update();
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(`${VERSION} (${short(BUILD.commit)})`);
    break;
  default:
    help();
}
