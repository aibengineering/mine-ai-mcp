import type { Bot } from "mineflayer";
import { EventEmitter } from "node:events";
import { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../session/action-runner.js";
import { ReflexDriver } from "../survival/control/driver.js";

export function waterFixture(t: TestContext) {
  let moving = false;
  const controls: Array<readonly [control: string, state: boolean]> = [];
  const entity = { isInWater: false, position: new Vec3(0, 64, 0), yaw: 0, onGround: true };
  const bot = Object.assign(new EventEmitter(), {
    entity,
    registry: { entitiesByName: { player: { metadataKeys: ["air_supply"] } } },
    setControlState: (control: string, state: boolean) => controls.push([control, state]),
  }) as unknown as Bot;
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
