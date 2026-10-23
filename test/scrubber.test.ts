/**
 * Scrubber.fake() when the random fake happens to equal the recorded value.
 *
 * Found by CI on PR #3: `test (ubuntu-latest, 22)` failed in review.test.ts
 * because the mock served "adA" for the recorded name "Ada". The fake is drawn
 * with a random salt, letter by letter; about once in 26³ runs it drew "Ada"
 * itself, and the fallback reversed it: the wrong shape ("adA") and the
 * recorded value in plain sight, backwards.
 */
import { describe, expect, it } from "vitest";
import { Scrubber } from "../src/redact.js";

/** Same character class at every position: upper, lower, digit, or the same separator. */
function sameShape(fake: string, recorded: string): boolean {
  if (fake.length !== recorded.length) return false;
  return [...recorded].every((c, i) => {
    const f = fake[i]!;
    if (/[A-Z]/.test(c)) return /[A-Z]/.test(f);
    if (/[a-z]/.test(c)) return /[a-z]/.test(f);
    if (/[0-9]/.test(c)) return /[0-9]/.test(f);
    return f === c;
  });
}

const reversed = (s: string) => [...s].reverse().join("");

describe("a fake that collides with the recorded value", () => {
  it.each([
    [576, "Ada"],
    [1522, "Ada"],
    [1198, "Bo"],
  ])("seed %i, %s: is drawn again, not reversed", (seed, recorded) => {
    const fake = new Scrubber({ seed }).fake(recorded);
    expect(fake).not.toBe(recorded);
    expect(fake).not.toBe(reversed(recorded));
    expect(sameShape(fake, recorded)).toBe(true);
  });

  it("stays the same fake for the same value within one scrubber", () => {
    const s = new Scrubber({ seed: 576 });
    expect(s.fake("Ada")).toBe(s.fake("Ada"));
  });
});

describe("generated: every seed keeps the shape and never returns the recorded value", () => {
  // Short values collide often (1 in 26 for one letter), so these runs reach the redraw path many times.
  const VALUES = ["Q", "7", "Bo", "Ada", "x7", "Ab1", "ord_9f8a", "u_1042"];
  const SEEDS = 20000;

  it.each(VALUES)("%s", (recorded) => {
    const bad: string[] = [];
    for (let seed = 1; seed <= SEEDS && bad.length < 5; seed++) {
      const fake = new Scrubber({ seed }).fake(recorded);
      if (fake === recorded || !sameShape(fake, recorded)) bad.push(`seed ${seed}: ${fake}`);
    }
    expect(bad).toEqual([]);
  });
});
