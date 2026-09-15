import assert from "node:assert/strict";
import test from "node:test";
import { flatWorld, observation } from "../../test-support/navigation.js";
import { OpenedPassages } from "./opened-passages.js";

function fixture() {
  const world = flatWorld();
  const position = { x: 1, y: 63, z: 0 };
  const setDoor = (open: boolean) => {
    for (const y of [63, 64])
      world.load(
        { ...position, y },
        {
          stateId: open ? 3 : 2,
          traits: { activationGroup: "oak_door", openable: true, open, upperHalf: y === 64 },
        },
      );
  };
  setDoor(false);
  const passages = new OpenedPassages(world, "overworld");
  return { world, position, setDoor, passages };
}

test("a replanned route retains an owned open door until its remaining dependencies are passed", () => {
  const { position, setDoor, passages } = fixture();
  passages.remember(passages.closedAt(position));
  setDoor(true);
  const upper = { ...position, y: position.y + 1 };
  assert.equal(passages.nextToClose(observation(0), [upper]), null);
  const shoulder = { ...observation(0), position: { x: 0.73, y: 63, z: 0.5 } };
  assert.equal(passages.clearanceCell(shoulder, [upper]), null);
  assert.deepEqual(passages.nextToClose(observation(3), [])?.position, position);
});

test("restoration waits for the whole opening to be acknowledged, and stops once it is undone", () => {
  const { world, position, setDoor, passages } = fixture();
  passages.remember(passages.closedAt(position));
  assert.equal(passages.nextToClose(observation(3)), null, "Never toggle a door that still reads closed.");
  assert.match(passages.pending(observation(3))[0]!.observation, /not been confirmed/);

  // One half open is not the door open: toggling now would close the other.
  world.load(
    { ...position, y: 64 },
    { stateId: 3, traits: { activationGroup: "oak_door", openable: true, open: true, upperHalf: true } },
  );
  assert.equal(passages.nextToClose(observation(3)), null);
  assert.match(passages.pending(observation(3))[0]!.observation, /partially confirmed open/);

  setDoor(true);
  assert.deepEqual(passages.nextToClose(observation(3))?.position, position);
  setDoor(false);
  assert.deepEqual(passages.pending(observation(3)), [], "a door that closed itself is no longer owed");
});

test("passage restoration waits for the bot and other bodies to clear both door halves", () => {
  const { position, setDoor, passages } = fixture();
  passages.remember(passages.closedAt(position));
  setDoor(true);
  assert.match(passages.pending(observation(1))[0]!.observation, /bot still occupies/);
  const blocked = {
    ...observation(3),
    entities: new Map([
      [
        42,
        {
          id: 42,
          position: { x: 1.5, y: 64, z: 0.5 },
          width: 0.6,
          height: 1.8,
        },
      ],
    ]),
  };
  assert.equal(passages.nextToClose(blocked), null);
  assert.match(passages.pending(blocked)[0]!.observation, /entity occupies/);
  assert.ok(passages.nextToClose(observation(3)));
});

test("an initially open door is not owned, and a different dimension cannot restore an owned door", () => {
  const { position, setDoor, passages } = fixture();
  setDoor(true);
  assert.equal(passages.closedAt(position), null);
  assert.deepEqual(passages.pending(observation(3)), []);
  setDoor(false);
  passages.remember(passages.closedAt(position));
  setDoor(true);
  assert.ok(passages.nextToClose(observation(3)));
  const elsewhere = { ...observation(3), dimension: "the_nether" };
  assert.equal(passages.nextToClose(elsewhere), null);
  assert.match(passages.pending(elsewhere)[0]!.observation, /changed dimension/);
});

test("adjacent arrival can finish body clearance within its stance without walking out of a doorway cell", () => {
  const { position, setDoor, passages } = fixture();
  passages.remember(passages.closedAt(position));
  setDoor(true);
  const adjacent = { ...observation(0), position: { x: 0.73, y: 63, z: 0.5 } };
  assert.deepEqual(passages.clearanceCell(adjacent), { x: 0, y: 63, z: 0 });
  assert.equal(passages.clearanceCell(observation(1)), null, "Cleanup cannot select a different stance.");
  assert.equal(passages.clearanceCell(observation(0)), null, "A body already clear needs no adjustment.");
});
