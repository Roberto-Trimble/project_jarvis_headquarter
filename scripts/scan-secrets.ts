// Fail if any tracked file contains a secret-shaped string. Uses the same shapes as the Shortcut Board.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { containsSecret } from "../src/rules.ts";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n").filter((f) => f && !f.startsWith("test/") && !/\.(png|jpg|woff2?|ico)$/.test(f) && f !== "package-lock.json");
const hits = files.filter((f) => {
  try { return containsSecret(readFileSync(f, "utf8")); } catch { return false; }
});
if (hits.length) {
  console.error(`secret-shaped text in: ${hits.join(", ")}`);
  process.exit(1);
}
console.log(`scan:secrets ok (${files.length} files)`);
