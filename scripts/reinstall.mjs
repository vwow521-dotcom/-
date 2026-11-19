// Rebuild the install package from this tree and reinstall it globally, then refresh client config.
//   npm run reinstall
// Steps: ai-bridge uninstall (if installed) → npm pack → npm install -g → ai-bridge setup → ai-bridge doctor.
import { execSync } from "node:child_process";
import fs from "node:fs";

const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
};
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tgz = `release/ai-bridge-${version}.tgz`;

try {
  run("ai-bridge uninstall");
} catch {
  console.log("（之前没有安装 ai-bridge，跳过卸载）");
}
fs.mkdirSync("release", { recursive: true });
run("npm pack --pack-destination release");
run(`npm install -g ${tgz}`);
run("ai-bridge setup");
run("ai-bridge doctor");
