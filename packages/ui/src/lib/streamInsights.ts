export type StreamKind = "ws" | "sse";
export type StreamStatus = "idle" | "connecting" | "open" | "closed" | "error";
export type StreamInsightTone = "info" | "good" | "warn" | "bad";

export type StreamLogEntry = {
  dir: "in" | "out" | "sys";
  data: string;
  ts: number;
  status?: "sent" | "error";
  isBinary?: boolean;
  streamEvent?: string;
  sysEvent?: "open" | "close" | "error";
  url?: string;
  openStatus?: number;
  closeCode?: number;
  closeReason?: string;
};

export type StreamInsight = {
  title: string;
  detail: string;
  value?: string;
  tone: StreamInsightTone;
};

function closeTone(code: number | undefined): StreamInsightTone {
  if (code === undefined || code === 1000 || code === 1005) return "good";
  if (code >= 4000 || code === 1006 || code === 1011) return "bad";
  return "warn";
}

function streamName(kind: StreamKind): string {
  return kind === "sse" ? "SSE" : "WebSocket";
}

export function buildStreamInsights(input: {
  kind: StreamKind;
  status: StreamStatus;
  messages: StreamLogEntry[];
}): StreamInsight[] {
  const { kind, status, messages } = input;
  const out: StreamInsight[] = [];
  const opened = [...messages].reverse().find((m) => m.sysEvent === "open");
  const closed = [...messages].reverse().find((m) => m.sysEvent === "close");
  const error = [...messages].reverse().find((m) => m.sysEvent === "error");
  const inbound = messages.filter((m) => m.dir === "in");
  const outbound = messages.filter((m) => m.dir === "out");
  const sendFailures = outbound.filter((m) => m.status === "error");
  const binary = inbound.filter((m) => m.isBinary);
  const eventTypes = [
    ...new Set(
      inbound
        .map((m) => m.streamEvent?.trim())
        .filter((event): event is string => !!event)
    ),
  ];

  if (opened) {
    out.push({
      title: `${streamName(kind)} connected`,
      detail: opened.url || "The stream handshake completed.",
      value: opened.openStatus ? `${opened.openStatus}` : undefined,
      tone:
        opened.openStatus && opened.openStatus >= 400
          ? "bad"
          : opened.openStatus && opened.openStatus >= 300
            ? "warn"
            : "good",
    });
  } else if (status === "connecting") {
    out.push({
      title: "Handshake pending",
      detail: `${streamName(kind)} connection is still opening.`,
      tone: "warn",
    });
  }

  if (error) {
    out.push({
      title: "Stream error",
      detail:
        error.data.replace(/^●\s*/, "") || "The stream reported an error.",
      tone: "bad",
    });
  }

  if (closed) {
    const code = closed.closeCode;
    out.push({
      title: "Close frame",
      detail: closed.closeReason || "The stream closed without a reason.",
      value: code !== undefined ? `${code}` : undefined,
      tone: closeTone(code),
    });
  }

  if (inbound.length || outbound.length) {
    out.push({
      title: "Frame traffic",
      detail:
        kind === "sse"
          ? "Server-sent events are inbound-only."
          : `${outbound.length} outbound frame${outbound.length === 1 ? "" : "s"}, ${inbound.length} inbound frame${inbound.length === 1 ? "" : "s"}.`,
      value: `${inbound.length} in / ${outbound.length} out`,
      tone: "info",
    });
  }

  if (sendFailures.length) {
    out.push({
      title: "Send failures",
      detail: "One or more outbound frames failed before reaching the stream.",
      value: `${sendFailures.length}`,
      tone: "bad",
    });
  }

  if (eventTypes.length) {
    out.push({
      title: kind === "sse" ? "SSE event types" : "Stream event types",
      detail: eventTypes.slice(0, 4).join(", "),
      value:
        eventTypes.length > 4 ? `+${eventTypes.length - 4} more` : undefined,
      tone: "info",
    });
  }

  if (binary.length) {
    out.push({
      title: "Binary frames",
      detail: "Inbound binary frames were captured as base64 and shown in hex.",
      value: `${binary.length}`,
      tone: "info",
    });
  }

  if (opened && inbound.length === 0 && status === "open") {
    out.push({
      title: "No inbound frames yet",
      detail: "The handshake completed but no server frames have arrived.",
      tone: "warn",
    });
  }

  return out;
}
