import type { z } from "zod";

/**
 * The one rule every tool that takes an optional target cell shares: x, y and
 * z name a cell only together, so a caller gives all three or none. Each tool
 * keeps its own wording of the refusal, which the model has already been
 * shown; the rule and the error shape (a zod issue at the MCP boundary) are
 * the same for all of them.
 */
export function wholeCell(message: string) {
  return (value: { x?: number; y?: number; z?: number }, context: z.RefinementCtx) => {
    const given = [value.x, value.y, value.z].filter((axis) => axis !== undefined).length;
    if (given !== 0 && given !== 3) context.addIssue({ code: "custom", message });
  };
}
