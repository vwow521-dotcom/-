import process from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

type Config = {
  min: number;
  max: number;
  tries: number;
  seed?: number;
  help: boolean;
};

const usage = `用法  npx tsx playground/guess.ts [--min <整数>] [--max <整数>] [--tries <整数>] [--seed <整数>] [--help | -h]
默认范围为 1 到 100。输入 q、quit 或遇到 EOF 时退出码为 0，按 Ctrl+C 时为 130。`;

function parseInteger(text: string): number | undefined {
  if (!/^-?\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function parseArgs(argv: string[]): Config | { error: string } {
  const values: Partial<Record<"--min" | "--max" | "--tries" | "--seed", number>> = {};
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    if (flag !== "--min" && flag !== "--max" && flag !== "--tries" && flag !== "--seed") {
      return { error: `未知参数 ${JSON.stringify(flag)}` };
    }
    const value = parseInteger(argv[i + 1] ?? "");
    if (value === undefined) return { error: `${flag} 需要一个安全整数` };
    if (flag === "--tries" && value < 1) return { error: "--tries 必须至少为 1" };
    values[flag] = value;
    i += 1;
  }

  const min = values["--min"] ?? 1;
  const max = values["--max"] ?? 100;
  if (min > max) return { error: "--min 必须小于或等于 --max" };

  const span = BigInt(max) - BigInt(min) + 1n;
  // ceil(log2(span)) is the bit length of span - 1.
  const defaultTries = span === 1n ? 1 : (span - 1n).toString(2).length + 1;
  return { min, max, tries: values["--tries"] ?? defaultTries, seed: values["--seed"], help };
}

export function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;

  let state = seed >>> 0;
  // Mulberry32
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

export function judge(guess: number, secret: number): "low" | "high" | "correct" {
  if (guess === secret) return "correct";
  return guess < secret ? "low" : "high";
}

async function main(): Promise<number> {
  const config = parseArgs(process.argv.slice(2));
  if ("error" in config) {
    console.error(`${config.error}\n${usage}`);
    return 2;
  }
  if (config.help) {
    console.log(usage);
    return 0;
  }

  const { min, max, tries, seed } = config;
  const random = makeRng(seed);
  // Scale a 64-bit draw across the inclusive range using exact integer arithmetic.
  const high = BigInt(Math.floor(random() * 2 ** 32));
  const low = BigInt(Math.floor(random() * 2 ** 32));
  const span = BigInt(max) - BigInt(min) + 1n;
  const offset = (((high << 32n) | low) * span) >> 64n;
  const secret = Number(BigInt(min) + offset);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
    crlfDelay: Infinity,
  });

  const guesses = new Set<number>();
  let attempts = 0;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    lines.close();
  };
  lines.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);

  try {
    console.log(`我选了 ${min} 到 ${max} 之间的一个整数，你有 ${tries} 次机会。输入 q 可退出。`);
    if (interactive) lines.prompt();

    for await (const line of lines) {
      const input = line.trim();
      if (interrupted || /^(q|quit)$/i.test(input)) break;

      const guess = parseInteger(input);
      if (guess === undefined || guess < min || guess > max) {
        console.log(`请输入 ${min} 到 ${max} 之间的整数`);
      } else {
        attempts += 1;
        if (guesses.has(guess)) console.log(`你已经猜过 ${guess} 了`);
        guesses.add(guess);

        const result = judge(guess, secret);
        if (result === "correct") {
          console.log(`猜中了！答案是 ${secret}，用了 ${attempts} 次。`);
          return 0;
        }
        console.log(result === "high" ? "太大了" : "太小了");
        if (attempts === tries) {
          console.log(`次数用完，答案是 ${secret}。`);
          return 1;
        }
      }
      if (interactive) lines.prompt();
    }

    console.log(`已退出，答案是 ${secret}。`);
    return interrupted ? 130 : 0;
  } finally {
    process.off("SIGINT", interrupt);
    lines.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
