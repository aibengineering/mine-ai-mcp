import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../../../navigation/world/memory-world.js";
import { Answered } from "../../state/answered.js";
import { geometryAnswer } from "./geometry-answer.js";

test("geometry answers start after settlement and retire their region listener on invalidation", () => {
  const world = new MemoryWorld();
  const answered = new Answered();
  let listeners = 0;
  const subscribe = world.subscribe.bind(world);
  world.subscribe = (listener) => {
    listeners++;
    const stop = subscribe(listener);
    return () => {
      listeners--;
      stop();
    };
  };
  const scope = geometryAnswer(world, new Vec3(0, 64, 0), 3, {
    capability: "position",
    response: "cover",
    scope: "A",
    facts: () => null,
    permissions: () => null,
  });
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 1 });
  assert.equal(listeners, 0);
  answered.remember(scope, { kind: "no_route", why: "The constructed wall blocked the route" });
  assert.equal(listeners, 1);
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 1 });
  world.load({ x: 20, y: 64, z: 0 }, { stateId: 2 });
  assert.ok(answered.find("position", "A"));
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 0 });
  assert.equal(answered.find("position", "A"), null);
  assert.equal(listeners, 0);
});
