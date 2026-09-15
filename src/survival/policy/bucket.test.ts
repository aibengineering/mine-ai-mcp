import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../../test-support/bot.js";
import { SurvivalPolicyState } from "../state/survival-policy.js";
import { readNavigationPolicy } from "../state/navigation-policy.js";
import { createMovements } from "../../navigation/runtime.js";

test("bucket navigation flags are independent and live across set, clear and death reset", async () => {
  const bot = botFixture({items:[{name:"water_bucket",count:1}]});
  const policy = new SurvivalPolicyState(bot);
  const movements = createMovements(bot);
  assert.equal(movements.maximumBucketDrop,80);
  await policy.edit({operation:"set",expected_revision:policy.snapshot().revision,changes:{navigation:{bucket_fall_save:false}},lifetime:{kind:"session"},reason:"disable emergency rescue"});
  assert.equal(readNavigationPolicy(bot).bucket_fall_save,false); assert.equal(movements.maximumBucketDrop,80);
  await policy.edit({operation:"set",expected_revision:policy.snapshot().revision,changes:{navigation:{bucket_drops:false}},lifetime:{kind:"session"},reason:"disable planned drops"});
  assert.equal(movements.maximumBucketDrop,0);
  await policy.edit({operation:"clear",expected_revision:policy.snapshot().revision,paths:["navigation.bucket_fall_save"],reason:"restore rescue"});
  assert.equal(readNavigationPolicy(bot).bucket_fall_save,true);assert.equal(movements.maximumBucketDrop,0);
  await policy.reset("death"); assert.equal(movements.maximumBucketDrop,80);
});
