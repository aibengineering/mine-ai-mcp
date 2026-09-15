import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MineAiScenarioContext } from "./scenario-client.ts";

/** Keep driver-specific traces out of completion text; runtime incidents already own general telemetry. */
export async function writeScenarioEvidence(
  context: MineAiScenarioContext,
  name: string,
  evidence: object,
): Promise<string> {
  const root = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (!root) throw new Error("Mine Labs did not provide an artifacts directory for scenario evidence.");
  const directory = path.join(root, context.bot.username);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return file;
}
