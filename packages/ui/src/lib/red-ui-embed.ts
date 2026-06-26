import {
  InjectedClientProvider,
  RedClient,
  type ConnectionProvider,
} from "@reddb-io/ui/embed";
import { reddbRequest, type ReddbHttpReply } from "./rpc";

type ReddbRequestFn = (
  method: string,
  path: string,
  body: string | null
) => Promise<ReddbHttpReply>;

async function bodyToString(
  body: BodyInit | null | undefined
): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    );
  }
  throw new Error(
    "red-ui embedded fetch only supports buffered request bodies"
  );
}

/** Fetch adapter for @reddb-io/ui. It reuses red-request's Rust HTTP bridge instead of
 * letting the webview talk directly to the localhost sidecar. */
export function embeddedRedUiFetch(
  baseUrl: string,
  request: ReddbRequestFn = reddbRequest
): typeof fetch {
  const base = new URL(baseUrl);

  return async (input, init = {}) => {
    const req = input instanceof Request ? input : null;
    const rawUrl =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;
    const url = new URL(rawUrl, base);
    if (url.origin !== base.origin) {
      throw new Error(
        `red-ui tried to leave the managed RedDB endpoint: ${url.origin}`
      );
    }

    const method = init.method ?? req?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    const requestBody =
      init.body !== undefined
        ? init.body
        : req && !["GET", "HEAD"].includes(method.toUpperCase())
          ? await req.clone().text()
          : null;
    const body = await bodyToString(requestBody);
    const reply = await request(method, path, body);
    const headers = new Headers({
      "content-type": path.startsWith("/query/stream")
        ? "application/x-ndjson"
        : "application/json",
    });
    return new Response(reply.body, {
      status: reply.status,
      statusText:
        reply.status >= 200 && reply.status < 300 ? "OK" : "RedDB Error",
      headers,
    });
  };
}

export function createRedUiProvider(
  endpointUrl: string,
  dbPath: string | undefined
): ConnectionProvider {
  const client = new RedClient(endpointUrl, {
    fetch: embeddedRedUiFetch(endpointUrl),
  });
  return new InjectedClientProvider({
    client,
    connection: {
      id: "red-request-store",
      label: "red-request store",
      url: dbPath ?? endpointUrl,
      role: "embedded",
      description: "The managed RedDB sidecar already opened by red-request.",
    },
  });
}
