import { z } from "zod";

/**
 * Timing breakdown — fields confirmed against recker@1.0.103's response.timings:
 * { queuing, dns, tcp, tls, firstByte, content, total } (milliseconds).
 */
export const timingsSchema = z.object({
  queuing: z.number().optional(),
  dns: z.number().optional(),
  tcp: z.number().optional(),
  tls: z.number().optional(),
  firstByte: z.number().optional(),
  content: z.number().optional(),
  total: z.number().optional(),
});
export type Timings = z.infer<typeof timingsSchema>;

export const responseErrorSchema = z.object({
  message: z.string(),
  /** recker HttpError classification, when present (e.g. "client_error"). */
  classification: z.string().optional(),
  retriable: z.boolean().optional(),
});
export type ResponseError = z.infer<typeof responseErrorSchema>;

/**
 * The serializable result of a dispatch. Always returned (never thrown) so the UI can
 * render 4xx/5xx and transport failures alike. `bodyBase64` carries non-text payloads.
 */
export const responseResultSchema = z.object({
  status: z.number(),
  statusText: z.string().default(""),
  ok: z.boolean(),
  url: z.string().default(""),
  headers: z.record(z.string(), z.string()).default({}),
  bodyText: z.string().default(""),
  bodyBase64: z.string().optional(),
  contentType: z.string().optional(),
  size: z.number().default(0),
  durationMs: z.number().default(0),
  timings: timingsSchema.optional(),
  /** Structured result for non-HTTP kinds (dns records, ping stats, whois parsed). */
  meta: z.record(z.string(), z.unknown()).optional(),
  error: responseErrorSchema.optional(),
});
export type ResponseResult = z.infer<typeof responseResultSchema>;
