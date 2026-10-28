import { z } from "zod";

/** Named observations, not an opaque fingerprint or a full policy revision. */
export type Facts = null | boolean | number | string | readonly Facts[] | { readonly [name: string]: Facts };

export const factsSchema: z.ZodType<Facts, Facts> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(factsSchema), z.record(z.string(), factsSchema)]),
);
