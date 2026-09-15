import type { Position3 } from "../../utils/index.js";
import { holdSwimDepth } from "../world/swimming.js";
import { horizontalControlsToward, type HorizontalSteeringControl } from "./local-steering.js";

interface WaterPositionBot {
  readonly entity: { readonly position: Position3; readonly velocity?: Position3; readonly onGround?: boolean; readonly yaw?: number; readonly isInWater?: boolean };
  on(event: "physicsTick", listener: () => void): unknown;
  off(event: "physicsTick", listener: () => void): unknown;
  setControlState(control: HorizontalSteeringControl | "jump", active: boolean): void;
}

/** Hold a stationary interaction against a current without changing its aim. */
export function holdWaterPosition(
  bot: WaterPositionBot,
  signal: AbortSignal | undefined,
  setControl: (control: HorizontalSteeringControl | "jump", active: boolean) => void = (control, active) =>
    bot.setControlState(control, active),
): () => void {
  const standing = { ...bot.entity.position };
  const controls = ["forward", "back", "left", "right"] as const;
  const hold = () => {
    const correction = horizontalControlsToward(
      { position: bot.entity.position, yaw: bot.entity.yaw ?? 0 },
      standing,
      0.05,
    );
    for (const control of controls)
      setControl(control, !signal?.aborted && bot.entity.isInWater === true && correction[control]);
    // Supported mining must stay on its floor: jumping multiplies dig time again.
    if (bot.entity.isInWater) setControl("jump", !signal?.aborted && !bot.entity.onGround &&
      holdSwimDepth(bot.entity.position.y, bot.entity.velocity?.y ?? 0, standing.y));
  };
  bot.on("physicsTick", hold);
  return () => {
    bot.off("physicsTick", hold);
    for (const control of controls) setControl(control, false);
    setControl("jump", false);
  };
}
