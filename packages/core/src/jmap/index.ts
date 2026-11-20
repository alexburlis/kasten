export {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_SUBMISSION,
  CAPABILITY_WEBPUSH_VAPID,
  JmapClient,
  JmapResponse,
  primaryAccountId,
  resultOf,
  type EventSourceOptions,
  type HttpTransport,
  type Invocation,
  type JmapClientOptions,
  type JmapSession,
  type ResultReference,
  type UploadedBlob,
} from "./client.ts";

export { KastenJmapError, type KastenJmapErrorInit } from "./errors.ts";

export type { JsonObject, JsonValue } from "../json.ts";
