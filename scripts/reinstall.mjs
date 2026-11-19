// Rebuild the install package from this tree and reinstall it globally, then refresh client config.
//   npm run reinstall
// Steps: npm pack (runs prepare: build + build-info) → npm install -g → ai-bridge setup --refresh → ai-bridge doctor.
// `--refresh` only updates clients that already have a bridge entry; run `ai-bridge setup` once to add new ones.
// To install what is on GitHub instead of this working tree, use `ai-bridge update`.
import { execSync } from "node:child_process";
import fs from "node:fs";

const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
};
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tgz = `release/ai-bridge-${version}.tgz`;

fs.mkdirSync("release", { recursive: true });
run("npm pack --pack-destination release");
run(`npm install -g ${tgz}`);
run("ai-bridge setup --refresh");
run("ai-bridge doctor");
