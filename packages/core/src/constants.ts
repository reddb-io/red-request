export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export const BODY_TYPES = [
  "none",
  "json",
  "raw",
  "form",
  "multipart",
  "xml",
  "graphql",
] as const;

export const REQUEST_KINDS = [
  "http",
  "ws",
  "sse",
  "grpc",
  "tcp",
  "tls",
  "udp",
  "ping",
  "whois",
  "dns",
] as const;

export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "MX",
  "TXT",
  "NS",
  "CNAME",
  "SOA",
  "SRV",
  "CAA",
] as const;

/** A small catalog of current browser User-Agents to pick from when building a profile. */
export const USER_AGENTS: { name: string; value: string }[] = [
  {
    name: "Chrome · Windows",
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    name: "Chrome · macOS",
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    name: "Chrome · Linux",
    value:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    name: "Firefox · Windows",
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  },
  {
    name: "Firefox · macOS",
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  },
  {
    name: "Safari · macOS",
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  },
  {
    name: "Edge · Windows",
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  },
  {
    name: "Safari · iPhone",
    value:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  },
  {
    name: "Chrome · Android",
    value:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  },
  {
    name: "curl",
    value: "curl/8.11.0",
  },
];
