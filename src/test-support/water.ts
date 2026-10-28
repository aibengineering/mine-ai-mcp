import { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../runner/action-runner.js";
import { ReflexDriver } from "../survival/control/driver.js";
import { botFixture } from "./bot.js";

/**
 * A bot for the breath and idle-water tests, with a reflex driver disposed
 * when the test ends. `oxygenLevel` reads the air-supply metadata the way
 * Mineflayer does (0–20 from 0–300), so a test sets either and sees both;
 * `controls` records every control change, and `isMoving`/`setMoving` is a
 * flag a test hands its subject as whether a route currently owns movement.
 */
export function waterFixture(t: TestContext) {
  let moving = false;
  const controls: Array<readonly [control: string, state: boolean]> = [];
  const bot = botFixture(
    { position: new Vec3(0, 64, 0) },
    {
      // Only the air-supply key: the getter below reads it at metadata index 0.
      registry: { entitiesByName: { player: { metadataKeys: ["air_supply"] } } },
      setControlState: (control: string, state: boolean) => controls.push([control, state]),
    },
  );
  // botFixture sets it; Mineflayer's Entity type does not declare it.
  const entity = bot.entity as typeof bot.entity & { isInWater: boolean };
  const reflex = new ReflexDriver(bot, new ActionRunner());
  t.after(() => reflex[Symbol.asyncDispose]());
  Object.assign(entity, { metadata: [] });
  Object.defineProperty(bot, "oxygenLevel", {
    get: () => Number(bot.entity.metadata[0]) / 15,
    set: (value: number) => {
      Reflect.set(bot.entity.metadata, 0, value * 15);
    },
    configurable: true,
  });

  return {
    bot,
    reflex,
    entity,
    controls,
    isMoving: () => moving,
    setMoving: (value: boolean) => {
      moving = value;
    },
  };
}
