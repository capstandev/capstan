// live-check helpers: runtime code compared with immutables masked, and each immutable read back.
import { describe, expect, test } from "bun:test";
import { compareRuntime, immutableValues, maskImmutables } from "../live-check";

describe("live check", () => {
  const build = `0x6080aa${"00".repeat(32)}bb` as `0x${string}`;
  const refs = { "7": [{ start: 3, length: 32 }] };
  const val = "00000000000000000000000011111111111111111111111111111111111111111".slice(0, 64);
  const chain = `0x6080aa${val}bb` as `0x${string}`;
  test("equal code with a different immutable compares equal; any other byte does not", () => {
    expect(maskImmutables(chain, refs)).toBe(maskImmutables(build, refs));
    expect(compareRuntime(chain, { deployedBytecode: { object: build, immutableReferences: refs } }).equal).toBe(true);
    const tampered = `0x6080ab${val}bb` as `0x${string}`;
    expect(compareRuntime(tampered, { deployedBytecode: { object: build, immutableReferences: refs } }).equal).toBe(false);
    expect(compareRuntime(`${chain}00` as `0x${string}`, { deployedBytecode: { object: build, immutableReferences: refs } }).equal).toBe(false);
  });
  test("immutable values are read from their offsets; copies that disagree read as null", () => {
    expect(immutableValues(chain, refs)).toEqual({ "7": val });
    const two = { "7": [{ start: 0, length: 2 }, { start: 3, length: 2 }] };
    expect(immutableValues("0x6080aa6080", two)).toEqual({ "7": "6080" });
    expect(immutableValues("0x6080aa6081", two)).toEqual({ "7": null });
  });
});
