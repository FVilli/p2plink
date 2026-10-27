import { describe, expect, it } from "vitest";
import { formatByteSize } from "../format.js";

describe("formatByteSize", () => {
  it("selects the unit from the value with one decimal for KB/MB", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatByteSize(1.25 * 1024 * 1024)).toBe("1.3 MB");
  });

  it("renders invalid values safely", () => {
    expect(formatByteSize(null)).toBe("—");
    expect(formatByteSize(Number.NaN)).toBe("—");
    expect(formatByteSize(-1)).toBe("—");
  });
});
