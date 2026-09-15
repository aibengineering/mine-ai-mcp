import { z } from "zod";

/** Parse one exact Minecraft registry name at an MCP boundary. */
export const registryNameSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase().replace(/^minecraft:/u, "").replace(/[ -]+/gu, "_"))
  .pipe(z.string().min(1));
