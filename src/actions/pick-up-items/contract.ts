import {z} from 'zod';

import {type ActionOutput, actionResultSchema} from '../action.js';
import {registryNameSchema} from '../registry-name.js';

export const PICK_UP_ITEMS = 'pick_up_items' as const;
export const PICK_UP_ITEMS_DESCRIPTION =
    'Pick up loaded dropped-item entities in an area, optionally filtering by exact item registry name. Death recovery uses the last retained death position in the current dimension. Results report net inventory gain; an item disappearing is not claimed as collected. The five-minute recovery refusal is conservative wall time: Minecraft item despawn age pauses while its chunk is unloaded, so an older death may still have items.';

export const pickUpItemsInputSchema =
    z.strictObject({
       item: registryNameSchema.optional().describe('Exact dropped item registry name; omit for every item.'),
       x: z.number().finite().optional(),
       y: z.number().finite().optional(),
       z: z.number().finite().optional(),
       radius: z.number().positive().max(32).default(8),
       recover_death_items: z.boolean().default(false),
     }).superRefine((value, context) => {
      const coordinates = [value.x, value.y, value.z].filter((part) => part !== undefined).length;
      if (coordinates !== 0 && coordinates !== 3)
        context.addIssue({code: 'custom', message: 'x, y, and z must be supplied together.'});
      if (value.recover_death_items && coordinates !== 0)
        context.addIssue(
            {code: 'custom', message: 'recover_death_items chooses the retained death position; omit x, y, and z.'});
    });

export interface PickUpItemsRequest {
  readonly item?: string;
  readonly center?: {x: number; y: number; z: number};
  readonly radius: number;
  readonly recoverDeathItems: boolean
}
export function parsePickUpItemsRequest(input: unknown): PickUpItemsRequest {
  const value = pickUpItemsInputSchema.parse(input ?? {});
  return {
    ...(value.item ? {item: value.item} : {}),
    ...(value.x !== undefined ? {center: {x: value.x, y: value.y!, z: value.z!}} : {}),
    radius: value.radius,
    recoverDeathItems: value.recover_death_items
  };
}

const positionSchema = z.strictObject({x: z.number(), y: z.number(), z: z.number()});
const sightingSchema = z.strictObject({
  id: z.number().int(),
  item: z.string(),
  observedCount: z.number().int().positive(),
  position: positionSchema,
  outcome: z.enum(['collected', 'gone_unconfirmed', 'unreachable', 'inventory_full'])
});
const recoverySchema = z.strictObject({
                          dimension: z.string(),
                          position: positionSchema,
                          observedAt: z.string(),
                          cause: z.string().nullable(),
                          wallAgeMs: z.number().nonnegative()
                        }).nullable();
const evidenceSchema = z.strictObject({
  item: z.string().nullable(),
  center: positionSchema,
  radius: z.number(),
  observed: z.number().int().nonnegative(),
  collected: z.number().int().nonnegative(),
  gainedByItem: z.record(z.string(), z.number().int().nonnegative()),
  emptySlots: z.number().int().nonnegative(),
  sightings: z.array(sightingSchema),
  recovery: recoverySchema
});
export const pickUpItemsResultSchema = actionResultSchema({pickup: evidenceSchema});
export type PickUpItemsResult = z.output<typeof pickUpItemsResultSchema>;
export type PickUpItemsOutput = ActionOutput<typeof PICK_UP_ITEMS, PickUpItemsResult>;
