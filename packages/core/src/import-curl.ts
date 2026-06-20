// Parse a `curl` command (e.g. browser "Copy as cURL") into a RequestDefinition.
import { newRequest, type RequestDefinition } from "./request.js";

/** Split a curl command into tokens, honoring ', ", $'…' and backslash line continuations. */
export function tokenizeCurl(input: string): string[] {
  const s = input.replace(/\\\r?\n/g, " "); // join line continuations
  const out: string[] = [];
  let i = 0;
  let cur = "";
  let has = false;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'" || c === '"') {
      const quote = c;
      has = true;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (quote === '"' && s[i] === "\\" && i + 1 < s.length) {
          cur += s[i + 1];
          i += 2;
        } else {
          cur += s[i];
          i++;
        }
      }
      i++; // closing quote
    } else if (c === "$" && s[i + 1] === "'") {
      // ANSI-C quoting $'...'
      has = true;
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[i + 1];
          cur += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else {
          cur += s[i];
          i++;
        }
      }
      i++;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else {
      has = true;
      cur += c;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** Convert a curl command into a RequestDefinition (best-effort, common flags). */
export function curlToRequest(curl: string, id: string): RequestDefinition {
  const t = tokenizeCurl(curl.trim());
  if (t[0] === "curl") t.shift();

  let method = "";
  let url = "";
  const headers: { name: string; value: string; enabled: boolean }[] = [];
  let data = "";
  let user = "";
  let json = false;

  for (let i = 0; i < t.length; i++) {
    const a = t[i]!;
    const next = () => t[++i] ?? "";
    if (a === "-X" || a === "--request") method = next().toUpperCase();
    else if (a === "-H" || a === "--header") {
      const h = next();
      const idx = h.indexOf(":");
      if (idx > 0)
        headers.push({
          name: h.slice(0, idx).trim(),
          value: h.slice(idx + 1).trim(),
          enabled: true,
        });
    } else if (a === "-u" || a === "--user") user = next();
    else if (
      a === "-d" ||
      a === "--data" ||
      a === "--data-raw" ||
      a === "--data-binary" ||
      a === "--data-ascii"
    )
      data += (data ? "&" : "") + next();
    else if (a === "--json") {
      data += (data ? "&" : "") + next();
      json = true;
    } else if (a === "--url") url = next();
    else if (a === "-b" || a === "--cookie")
      headers.push({ name: "Cookie", value: next(), enabled: true });
    else if (a === "-A" || a === "--user-agent")
      headers.push({ name: "User-Agent", value: next(), enabled: true });
    else if (a.startsWith("-")) {
      // skip unknown flags; consume a value when the next token isn't a flag/url
      if (
        i + 1 < t.length &&
        !t[i + 1]!.startsWith("-") &&
        !/^https?:\/\//.test(t[i + 1]!) &&
        a !== "-L" &&
        a !== "--compressed" &&
        a !== "-k" &&
        a !== "--insecure" &&
        a !== "-s" &&
        a !== "--silent"
      )
        i++;
    } else if (!url) url = a;
  }

  if (!method) method = data ? "POST" : "GET";
  const ct = headers.find((h) => h.name.toLowerCase() === "content-type");
  const isJson =
    json || ct?.value.includes("json") || /^\s*[{[]/.test(data.trim());

  const base = newRequest(id);
  return {
    ...base,
    name: url.replace(/^https?:\/\//, "").slice(0, 60) || "Imported request",
    method: method as RequestDefinition["method"],
    url,
    headers,
    body: data
      ? { type: isJson ? "json" : "raw", content: data, fields: [] }
      : base.body,
    auth: user
      ? {
          type: "basic",
          username: user.split(":")[0] ?? "",
          password: user.split(":").slice(1).join(":"),
        }
      : base.auth,
  };
}
