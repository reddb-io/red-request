import { describe, it, expect } from "vitest";
import { hexRows, bytesFromBase64 } from "./hexdump.js";

describe("hexRows", () => {
  it("returns no rows for empty input", () => {
    expect(hexRows(new Uint8Array())).toEqual([]);
  });

  it("formats a single short row with correct offset, hex and ascii", () => {
    const rows = hexRows(new Uint8Array([0x48, 0x69, 0x21])); // "Hi!"
    expect(rows).toHaveLength(1);
    expect(rows[0]!.offset).toBe("00000000");
    expect(rows[0]!.hex).toEqual(["48", "69", "21"]);
    expect(rows[0]!.ascii).toBe("Hi!");
  });

  it("renders non-printable bytes as '.' in the ascii gutter", () => {
    const rows = hexRows(new Uint8Array([0x00, 0x41, 0x7f, 0xff, 0x09]));
    expect(rows[0]!.hex).toEqual(["00", "41", "7f", "ff", "09"]);
    // only 0x41 ('A') is printable; NUL, DEL, 0xff and TAB collapse to '.'
    expect(rows[0]!.ascii).toBe(".A...");
  });

  it("splits into 16-byte rows with incrementing offsets", () => {
    const bytes = new Uint8Array(35).map((_, i) => i);
    const rows = hexRows(bytes);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.offset).toBe("00000000");
    expect(rows[1]!.offset).toBe("00000010");
    expect(rows[2]!.offset).toBe("00000020");
    expect(rows[0]!.hex).toHaveLength(16);
    expect(rows[2]!.hex).toHaveLength(3); // 35 - 32 = 3 trailing bytes
  });

  it("honours a custom bytesPerRow width", () => {
    const rows = hexRows(new Uint8Array([1, 2, 3, 4, 5]), 4);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.hex).toEqual(["01", "02", "03", "04"]);
    expect(rows[1]!.offset).toBe("00000004");
    expect(rows[1]!.hex).toEqual(["05"]);
  });
});

describe("bytesFromBase64", () => {
  it("decodes ascii text", () => {
    expect([...bytesFromBase64("SGkh")]).toEqual([0x48, 0x69, 0x21]); // "Hi!"
  });

  it("decodes with padding", () => {
    expect([...bytesFromBase64("AAEC")]).toEqual([0, 1, 2]);
    expect([...bytesFromBase64("/w==")]).toEqual([0xff]);
  });

  it("round-trips arbitrary binary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 127, 128]);
    const b64 = btoa(String.fromCharCode(...bytes)); // DOM-typed, no node Buffer needed
    expect([...bytesFromBase64(b64)]).toEqual([...bytes]);
  });

  it("ignores whitespace/newlines in the input", () => {
    expect([...bytesFromBase64("SG\nkh")]).toEqual([0x48, 0x69, 0x21]);
  });

  it("returns empty for empty input", () => {
    expect(bytesFromBase64("")).toEqual(new Uint8Array());
  });
});
