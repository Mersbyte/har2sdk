/** Release hygiene: one version everywhere, and a changelog entry for it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/codegen.js";
import { ROOT } from "./helpers.js";

describe("release", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  it("the generator's VERSION is package.json's version", () => {
    expect(VERSION).toBe(pkg.version);
  });
  it("CHANGELOG.md starts with that version", () => {
    expect(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")).toMatch(new RegExp(`^# Changelog\\r?\\n\\r?\\n## ${pkg.version.replace(/\./g, "\\.")}\\b`));
  });
  it("the README links only to files that exist", async () => {
    const { existsSync } = await import("node:fs");
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const links = [...readme.matchAll(/(?:\]\(|src=")((?:docs|examples|test)\/[^)"#\s]+)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(3);
    for (const l of links) expect(existsSync(join(ROOT, l)), l).toBe(true);
  });
});
