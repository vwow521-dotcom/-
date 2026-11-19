import { claude } from "./claude.js";
import { codex } from "./codex.js";
import type { ProductProfile } from "./types.js";

export const products: readonly ProductProfile[] = [claude, codex];
