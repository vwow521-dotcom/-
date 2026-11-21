import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { antigravity, deepseekHarness } from "./acp.js";
import type { BridgeClient, ProductProfile } from "./types.js";

export const products: readonly ProductProfile[] = [claude, codex, antigravity, deepseekHarness];

export function productById(id?: string) {
  return products.find((p) => id && p.ids.includes(id));
}

export function productByClient(client: BridgeClient) {
  if (client.claudeSocket?.present) return claude;
  const name = client.name.trim().toLowerCase();
  return products.find((p) => p.clientNames.includes(name));
}

export function versionWarning(product: ProductProfile, version: string) {
  if (version === "unknown" || product.verifiedVersions.some((prefix) => version === prefix || version.startsWith(prefix + "."))) return null;
  return "未验证的版本，门铃可能失效";
}
