import { z } from "zod";

/** A JSON value as JMAP sends and receives it. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/** A JSON object, such as the arguments of a JMAP method call. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const jsonObject: z.ZodType<JsonObject> = z.record(z.string(), jsonValue);

/** Parses JSON text into a {@link JsonValue}; throws a SyntaxError on invalid JSON. */
export function parseJson(text: string): JsonValue {
  return jsonValue.parse(JSON.parse(text));
}
