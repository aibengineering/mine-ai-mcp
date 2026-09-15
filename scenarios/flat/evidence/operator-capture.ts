import express from "express";
import { readFile } from "node:fs/promises";
import { openRuntime } from "../../src/runtime.ts";
import { registerIncidentCaptureRoute } from "../../../src/server/incident-route.ts";
import { incidentCaptureResultSchema } from "../../../src/bot-data/incident-log.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const runtime = await openRuntime(context, "operator-capture");
  const app = express();
  registerIncidentCaptureRoute(app, runtime);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Diagnostic server has no TCP address.");
    const capture = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/diagnostics/incidents`, { method: "POST" });
      const result = incidentCaptureResultSchema.parse(await response.json());
      if (!response.ok || result.kind !== "completed" || result.reference.artifact.kind !== "written")
        throw new Error(`Capture did not persist: ${JSON.stringify(result)}`);
      return result.reference;
    };
    const action = runtime.actions.find((action) => action.name === "navigate");
    if (!action) throw new Error("Missing navigation action.");
    const request = { x: 20, y: -60, z: 0, range: 0, dig: false, scaffold: false };
    const requestId = runtime.recordActionRequest({
      actionName: action.name,
      request,
      requestedAt: new Date().toISOString(),
      rationale: "Capture during normal movement",
    });
    const running = runtime.run(action, request, context.signal, requestId);
    while (context.bot.entity.position.x < 2) {
      context.signal.throwIfAborted();
      await context.bot.waitForTicks(1);
    }
    const before = JSON.stringify(runtime.notificationSummary());
    const first = await capture();
    const unchanged = before === JSON.stringify(runtime.notificationSummary());
    const result = await running;
    const second = await capture();
    if (first.artifact.kind !== "written") throw new Error("Missing captured artifact.");
    const source = await readFile(first.artifact.path, "utf8");
    const linked =
      first.requestId === requestId && second.requestId === null && second.precedingRequestId === requestId;
    const complete = result.result.status === "succeeded" && Math.floor(context.bot.entity.position.x) === 20;
    const recorded = source.includes('"kind":"physics"') && source.includes('"kind":"retained_plan"');
    const stats = runtime.status().incidents;
    return {
      status: linked && complete && recorded && unchanged ? "succeeded" : "failed",
      detail: `arrival ${complete}; request links ${linked}; physics/plan ${recorded}; notifications unchanged ${unchanged}; recorder ${JSON.stringify(stats)}; artifact ${first.artifact.path}`,
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await runtime.close();
  }
};
