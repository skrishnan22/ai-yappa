import * as v from 'valibot';

export type JsonPrimitive = string | number | boolean | null;

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonArray = JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export const jsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
	v.union([
		v.string(),
		v.number(),
		v.boolean(),
		v.null(),
		v.array(jsonValueSchema),
		v.record(v.string(), jsonValueSchema),
	]),
);

export const jsonObjectSchema: v.GenericSchema<JsonObject> = v.lazy(() =>
	v.record(v.string(), jsonValueSchema),
);

export function parsedOutput<TSchema extends v.GenericSchema>(
	schema: TSchema,
	value: JsonValue,
	message: string,
): v.InferOutput<TSchema> {
	const result = v.safeParse(schema, value);

	if (!result.success) throw new Error(message);

	return result.output;
}

export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : 'unknown error';
}
