import type { Express } from "express";
import type { MinecraftRuntime } from "../runtime/minecraft-runtime.js";

/** Developer-only capture; it never submits an action or takes movement controls. */
export function registerIncidentCaptureRoute(
  app: Express,
  runtime: Pick<MinecraftRuntime, "captureIncident">,
): void {
  app.post("/diagnostics/incidents", async (_request, response) => {
    const result = await runtime.captureIncident();
    const status =
      result.kind === "coalesced"
        ? 409
        : result.kind === "failed" || result.reference.artifact.kind === "failed"
          ? 500
          : 200;
    response.status(status).json(result);
  });
}
