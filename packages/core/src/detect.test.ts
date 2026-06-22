import { describe, it, expect } from "vitest";
import { detectBodyMode, sniffTextBody } from "./detect.js";

describe("detectBodyMode — content-type priority", () => {
  it("returns text for application/json", () => {
    expect(
      detectBodyMode({ contentType: "application/json", bodyText: "{}" })
    ).toBe("text");
  });

  it("returns text for text/* family", () => {
    expect(
      detectBodyMode({ contentType: "text/plain", bodyText: "hello" })
    ).toBe("text");
    expect(detectBodyMode({ contentType: "text/html", bodyText: "<p/>" })).toBe(
      "text"
    );
    expect(
      detectBodyMode({ contentType: "text/csv", bodyText: "a,b\n1,2" })
    ).toBe("text");
  });

  it("returns text for +json and +xml suffix types", () => {
    expect(
      detectBodyMode({ contentType: "application/ld+json", bodyText: "{}" })
    ).toBe("text");
    expect(
      detectBodyMode({
        contentType: "application/atom+xml",
        bodyText: "<feed/>",
      })
    ).toBe("text");
  });

  it("returns text for application/graphql", () => {
    expect(
      detectBodyMode({
        contentType: "application/graphql",
        bodyText: "query { id }",
      })
    ).toBe("text");
  });

  it("returns text for image/* (rendered as <img>, not hex viewer)", () => {
    expect(
      detectBodyMode({
        contentType: "image/png",
        bodyBase64: "abc==",
        bodyText: "",
      })
    ).toBe("text");
    expect(
      detectBodyMode({
        contentType: "image/jpeg",
        bodyBase64: "xyz==",
        bodyText: "",
      })
    ).toBe("text");
  });

  it("is case-insensitive on content-type", () => {
    expect(
      detectBodyMode({ contentType: "Application/JSON", bodyText: "{}" })
    ).toBe("text");
    expect(detectBodyMode({ contentType: "TEXT/PLAIN", bodyText: "hi" })).toBe(
      "text"
    );
  });

  it("returns text for image/svg+xml (matched by TEXT_CT before IMAGE_CT)", () => {
    expect(
      detectBodyMode({ contentType: "image/svg+xml", bodyText: "<svg/>" })
    ).toBe("text");
  });
});

describe("detectBodyMode — bodyBase64 rule", () => {
  it("returns binary when bodyBase64 is present and content-type is unknown", () => {
    expect(
      detectBodyMode({
        contentType: "application/octet-stream",
        bodyBase64: "AAEC",
        bodyText: "",
      })
    ).toBe("binary");
  });

  it("returns binary when there is no content-type and bodyBase64 is present", () => {
    expect(detectBodyMode({ bodyBase64: "AAEC", bodyText: "" })).toBe("binary");
  });

  it("returns text for a known text type even when bodyBase64 is set", () => {
    // content-type wins; bodyBase64 is checked only after CT rules
    expect(
      detectBodyMode({
        contentType: "application/json",
        bodyBase64: "e30=",
        bodyText: "{}",
      })
    ).toBe("text");
  });
});

describe("detectBodyMode — byte-level sniff fallback", () => {
  it("returns text for a normal ASCII body with no content-type", () => {
    expect(detectBodyMode({ bodyText: "Hello, world!" })).toBe("text");
  });

  it("returns text for an empty body", () => {
    expect(detectBodyMode({ bodyText: "" })).toBe("text");
  });

  it("returns text for body with only allowed whitespace control chars (tab, LF, CR)", () => {
    expect(detectBodyMode({ bodyText: "col1\tcol2\nrow1\trow2\r\n" })).toBe(
      "text"
    );
  });

  it("returns binary when ≥ 10 % of sampled chars are control bytes", () => {
    // 10 NUL chars out of 100 chars → exactly 10 %
    const body = "\x00".repeat(10) + "a".repeat(90);
    expect(detectBodyMode({ bodyText: body })).toBe("binary");
  });

  it("returns text when < 10 % of sampled chars are control bytes", () => {
    // 9 NUL chars out of 100 → 9 %
    const body = "\x00".repeat(9) + "a".repeat(91);
    expect(detectBodyMode({ bodyText: body })).toBe("text");
  });

  it("counts DEL (0x7f) as non-printable", () => {
    const body = "\x7f".repeat(10) + "a".repeat(90);
    expect(detectBodyMode({ bodyText: body })).toBe("binary");
  });
});

describe("sniffTextBody", () => {
  it("returns text for empty string", () => {
    expect(sniffTextBody("")).toBe("text");
  });

  it("returns text for all-printable ASCII", () => {
    expect(sniffTextBody("The quick brown fox.")).toBe("text");
  });

  it("returns binary on single NUL in a very short string (≥10%)", () => {
    expect(sniffTextBody("\x00abc")).toBe("binary"); // 1/4 = 25 %
  });

  it("only samples up to sampleSize chars", () => {
    // All bad chars beyond the sample window; within window all good
    const good = "a".repeat(10);
    const bad = "\x00".repeat(500);
    expect(sniffTextBody(good + bad, 10)).toBe("text");
  });
});
