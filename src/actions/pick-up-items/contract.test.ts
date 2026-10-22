import assert from 'node:assert/strict';
import test from 'node:test';

import {parsePickUpItemsRequest, pickUpItemsInputSchema} from './contract.js';

test('a named cell becomes the pickup area centre', () => {
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
