// Pure hex-dump formatting for binary payloads. Kept free of any DOM/Node API so the
// same logic powers the UI's hex viewer and stays unit-testable (see hexdump.test.ts).

const PRINTABLE_MIN = 0x20; // space
const PRINTABLE_MAX = 0x7e; // tilde

/** One rendered line of a hex dump: a byte offset, its hex columns and the ASCII gutter. */
export interface HexRow {
  /** Byte offset of this row's first byte, as a zero-padded 8-digit hex string. */
  offset: string;
  /** Two-digit lowercase hex for each byte in the row (length ≤ bytesPerRow). */
  hex: string[];
  /** ASCII rendering; non-printable bytes collapse to '.'. */
  ascii: string;
}

/**
 * Split a byte buffer into classic three-column hex-dump rows. Returns `[]` for empty input.
 * Non-printable bytes (outside 0x20–0x7e) render as '.' in the `ascii` gutter; offsets count
 * from zero in `bytesPerRow`-sized steps.
 */
export function hexRows(bytes: Uint8Array, bytesPerRow = 16): HexRow[] {
  const rows: HexRow[] = [];
  for (let i = 0; i < bytes.length; i += bytesPerRow) {
    const hex: string[] = [];
    let ascii = "";
    for (let j = i; j < i + bytesPerRow && j < bytes.length; j++) {
      const b = bytes[j]!;
      hex.push(b.toString(16).padStart(2, "0"));
      ascii +=
        b >= PRINTABLE_MIN && b <= PRINTABLE_MAX ? String.fromCharCode(b) : ".";
    }
    rows.push({ offset: i.toString(16).padStart(8, "0"), hex, ascii });
  }
  return rows;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/**
 * Decode a base64 string to raw bytes without depending on `Buffer` or `atob`, so the
 * decoder works identically in Node tests and the browser UI. Whitespace and padding (`=`)
 * are ignored; invalid characters are skipped.
 */
export function bytesFromBase64(b64: string): Uint8Array {
  const sextets: number[] = [];
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    const v = c < 128 ? (B64_LOOKUP[c] ?? -1) : -1;
    if (v >= 0) sextets.push(v);
  }
  const out = new Uint8Array((sextets.length * 6) >> 3);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const s of sextets) {
    acc = (acc << 6) | s;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
