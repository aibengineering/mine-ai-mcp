import assert from 'node:assert/strict';
import test from 'node:test';

import {parsePickUpItemsRequest, pickUpItemsInputSchema} from './contract.js';

test('pickup area requires either all coordinates or none and caps its loaded radius', () => {
  assert.throws(() => pickUpItemsInputSchema.parse({x: 1, radius: 8}), /x, y, and z/);
  assert.throws(() => pickUpItemsInputSchema.parse({radius: 33}));
  assert.deepEqual(parsePickUpItemsRequest({item: 'cobblestone', x: 1, y: 2, z: 3}), {
    item: 'cobblestone',
    center: {x: 1, y: 2, z: 3},
    radius: 8,
    recoverDeathItems: false,
  });
});

test('death recovery owns its centre and rejects conflicting coordinates', () => {
  assert.throws(
      () => pickUpItemsInputSchema.parse({recover_death_items: true, x: 1, y: 2, z: 3}), /retained death position/);
  assert.deepEqual(parsePickUpItemsRequest({recover_death_items: true}), {
    radius: 8,
    recoverDeathItems: true,
  });
});
