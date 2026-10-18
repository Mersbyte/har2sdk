#!/usr/bin/env node
// One-time setup before publishing: fills in the GitHub owner and the author.
//   npm run set-owner -- <github-username> "<Your Name>"
import { readFileSync, writeFileSync } from "node:fs";

const [user, name] = process.argv.slice(2);
if (!user || !/^[A-Za-z0-9-]{1,39}$/.test(user)) {
  console.error('Usage: npm run set-owner -- <github-username> "<Your Name>"');
  process.exit(1);
}
for (const file of ["package.json", "README.md", "SECURITY.md", "CHANGELOG.md"]) {
  const text = readFileSync(file, "utf8");
  const next = text.replaceAll("YOUR_GITHUB_USERNAME", user);
  if (next !== text) writeFileSync(file, next);
}
if (name) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  pkg.author = name;
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  const license = readFileSync("LICENSE", "utf8");
  writeFileSync("LICENSE", license.replace("the har2sdk authors", name));
}
console.log(`Done: github.com/${user}/har2sdk${name ? `, author ${name}` : ""}. Check with: git diff`);
