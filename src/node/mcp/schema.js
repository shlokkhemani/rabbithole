import { z } from "zod";

function applyCommon(schema, def) {
  let next = schema;
  if (def.description) next = next.describe(def.description);
  if (def.minItems != null && "min" in next) next = next.min(def.minItems);
  if (def.maxItems != null && "max" in next) next = next.max(def.maxItems);
  if (def.maxLength != null && "max" in next) next = next.max(def.maxLength);
  if (def.optional) next = next.optional();
  if (def.default !== undefined) next = next.default(def.default);
  return next;
}

function buildZodSchema(def) {
  switch (def.kind) {
    case "string":
      return applyCommon(z.string(), def);
    case "boolean":
      return applyCommon(z.boolean(), def);
    case "enum":
      return applyCommon(z.enum(def.values), def);
    case "array":
      return applyCommon(z.array(buildZodSchema(def.items)), def);
    case "object": {
      const shape = {};
      for (const [key, value] of Object.entries(def.fields)) shape[key] = buildZodSchema(value);
      return applyCommon(z.object(shape), def);
    }
    default:
      throw new Error(`Unsupported schema kind: ${def.kind}`);
  }
}

export function buildMcpInputSchema(def) {
  if (def.kind !== "object") throw new Error("Top-level MCP schema must be an object");
  const shape = {};
  for (const [key, value] of Object.entries(def.fields)) shape[key] = buildZodSchema(value);
  return shape;
}
