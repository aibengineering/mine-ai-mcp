# Navigation library

A Mineflayer-native pathfinding and movement engine that plans, executes, and settles physical routes in Minecraft.

The library exposes one public interface through [src/navigation/index.ts](../../src/navigation/index.ts). Higher-level systems, including Minecraft actions and goal-directed tasks, interact exclusively with this boundary. The internal search algorithms, movement catalogues, physics controllers, and world adapters stay private to the library.

## Actions reach navigation through a per-bot runtime

Navigation requires an explicit runtime handle. Callers obtain this handle by constructing one runtime per connected bot using [createNavigationRuntime](../../src/navigation/runtime.ts). There is no ambient global state or hidden singleton registry.

A caller that holds a [`NavigationRuntime`](../../src/navigation/runtime.ts) instance owns the bot's physical navigation. Minecraft actions receive this runtime from the active action session. The runtime arbitrates exclusive physical control between full path navigation, short-range local steering, and stationary block breaking.

## One engine, on purpose

The library is one implementation: the incremental A* search in [search/search.ts](../../src/navigation/search/search.ts) and the continuous physics execution in [execution/route-executor.ts](../../src/navigation/execution/route-executor.ts). There is no switch to `mineflayer-pathfinder` and no adapter for it.

## Quick start

This minimal script connects a bot, obtains a navigation runtime, builds default movement policies, and walks to an exact block target.

```typescript
import { createBot } from "mineflayer";
import {
  createNavigationRuntime,
  createMovements,
  exactBlockGoal,
  type NavigationResult,
} from "./src/navigation/index.js";

const bot = createBot({ host: "127.0.0.1", port: 25565, username: "Navigator" });

bot.once("spawn", async () => {
  const runtime = createNavigationRuntime(bot);
  const movements = createMovements(bot);
  const goal = exactBlockGoal({ x: 100, y: 64, z: 200 });

  const result: NavigationResult = await runtime.navigate({
    movements,
    goal,
    timeoutMs: 30_000,
  });

  if (result.status === "completed") {
    bot.chat(`Arrived in ${result.elapsedMs} ms.`);
  } else {
    bot.chat(`Stopped: ${result.reason} after ${result.elapsedMs} ms.`);
  }

  await runtime.close();
});
```

## Navigation documentation pages

- [API reference](api.md): Public functions, types, and constants exported from the library.
- [Goals and movements](goals-and-movements.md): Goal definitions, heuristic pricing, catalogue transitions, and movement policy rules.
- [Search and execution](search-and-execution.md): Incremental planning, search budgets, execution controllers, mutation tracking, and run orchestration.
- [Telemetry](telemetry.md): Structured lifecycle events, host logging controls, visual highlight feeds, and failure diagnosis.
