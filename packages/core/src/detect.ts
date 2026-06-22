// Pure binary-vs-text payload classifier. Kept free of any DOM/Node API so the
// same logic drives the UI default view and is fully unit-testable (detect.test.ts).

/**
 * Known text content-type families. Mirrors the TEXTY regex in the engine's recker.ts
 * so the UI and engine agree on what constitutes "text" at the content-type level.
 */
const TEXT_CT =
  /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql|.*\+json|.*\+xml)|image\/svg)/i;

/** Image content-types that render as inline `<img>` — not in the hex viewer. */
const IMAGE_CT = /^image\//i;

/**
 * Classify a response body as `'binary'` (→ hex viewer) or `'text'` (→ text view).
 *
 * Decision order:
 *  1. Known text content-type (text/*, application/json, …) → `'text'`
 *  2. Image content-type                                    → `'text'` (rendered as <img>)
 *  3. `bodyBase64` present (engine-confirmed non-text data) → `'binary'`
 *  4. Byte-level sniff of `bodyText`: ≥ 10 % control chars → `'binary'`
 *  5. Default                                               → `'text'`
 */
export function detectBodyMode(opts: {
  contentType?: string;
  bodyBase64?: string;
  bodyText: string;
}): "text" | "binary" {
  const ct = (opts.contentType ?? "").trim();
  if (TEXT_CT.test(ct)) return "text";
  if (IMAGE_CT.test(ct)) return "text";
  if (opts.bodyBase64) return "binary";
  return sniffTextBody(opts.bodyText);
}

/**
 * Sample up to `sampleSize` chars of `text` for C0 control bytes (except the common
 * text whitespace: tab 0x09, LF 0x0a, CR 0x0d) and DEL 0x7f. Returns `'binary'` when
 * the non-printable ratio reaches or exceeds 10 %.
 */
export function sniffTextBody(
  text: string,
  sampleSize = 512
): "text" | "binary" {
  const n = Math.min(text.length, sampleSize);
  if (n === 0) return "text";
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f)
      bad++;
  }
  return bad / n >= 0.1 ? "binary" : "text";
}
