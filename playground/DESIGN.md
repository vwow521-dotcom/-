# 猜数字（Guess the Number）— 设计说明

一个零依赖的命令行猜数字小游戏，用于验证协作桥的「规划 → 实现 → 审查」流水线。

## 1. 文件与运行

- 实现文件：`playground/guess.ts`（单文件，TypeScript，ESM）。
- 只用 Node 内置模块（`node:readline/promises`、`node:process`），不新增依赖。
- 运行：`npx tsx playground/guess.ts [参数]`
- 必须通过仓库根目录的 `npm run typecheck`。如果根 `tsconfig.json` 的 `include` 没覆盖 `playground/`，就在 `playground/` 下放一个最小的 `tsconfig.json`，或说明怎么单独检查。不要改动 `src/` 下的桥代码。

## 2. 玩法

1. 程序在 `[min, max]` 范围内随机选一个整数（两端都包含）。
2. 玩家每回合输入一个整数，程序回答：
   - `太大了` / `太小了`（可以附带剩余次数）
   - 猜中：`猜中了！答案是 N，用了 K 次。`，然后退出，退出码 0。
3. 次数上限默认 `ceil(log2(max - min + 1)) + 1`，保证用二分法一定能赢。用完还没猜中就输出 `次数用完，答案是 N。`，退出码 1。
4. 输入 `q` 或 `quit`（不区分大小写），或者 stdin 关闭（Ctrl+D / Ctrl+C），都打印 `已退出，答案是 N。`，退出码 130（Ctrl+C）或 0（q / EOF）。实现时二选一并写清楚，不要求精确区分。

## 3. 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--min <int>` | 1 | 下界 |
| `--max <int>` | 100 | 上界 |
| `--tries <int>` | 见上文公式 | 最大次数，必须 ≥ 1 |
| `--seed <int>` | 无 | 指定后用可复现的伪随机数（如 mulberry32），方便测试；不指定就用 `Math.random` |
| `--help` / `-h` | — | 打印用法，退出码 0 |

参数非法（不是整数、`min > max`、`tries < 1`、未知参数）时，往 stderr 打印一行错误和用法，退出码 2。

## 4. 输入校验

- 先去掉首尾空白再解析。只接受十进制整数（允许前导 `-`），拒绝 `3.5`、`1e2`、`abc` 和空行。
- 非法输入或超出范围的输入要提示（如 `请输入 1 到 100 之间的整数`），**不消耗次数**。
- 重复猜同一个数要消耗次数，但提示 `你已经猜过 X 了`。

## 5. 代码结构（便于审查和测试）

把纯逻辑和 I/O 分开：

- `parseArgs(argv: string[]): Config | { error: string }`，纯函数。
- `makeRng(seed?: number): () => number`
- `judge(guess: number, secret: number): "low" | "high" | "correct"`，纯函数。
- `main()`：负责 readline 循环和输出，用 `import.meta.url` 判断是否作为入口运行，这样被 import 时不会自动开始游戏。
- 导出前三个纯函数。

## 6. 验收标准（审查时逐条检查）

1. `npx tsx playground/guess.ts --seed 42 --min 1 --max 10` 每次运行的答案都一样。
2. 用管道喂输入能跑完、不挂起，例如 `printf "5\n3\n" | npx tsx playground/guess.ts --seed 42 --max 10`。stdin EOF 时干净退出。
3. 非法参数的退出码是 2，猜中是 0，次数用完是 1。
4. 非法输入不扣次数。
5. typecheck 通过，没有新增依赖。
6. 代码量大约 150 行以内，不过度设计。

## 7. 非目标

不做难度菜单、排行榜、持久化、颜色输出和国际化。
