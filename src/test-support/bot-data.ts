/** Bot-data stores for tests: in memory by default, or persistent under a temp root that outlives a reopen. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotDataScope } from "../bot-data/bot-data-identity.js";
import { SqlBotData } from "../bot-data/sql-bot-data.js";

export interface TemporaryBotDataOptions {
  readonly botId?: string;
  /** Close the store when this test finishes, for stores created inline in an expression. */
  readonly closeAfter?: { after(fn: () => void): void };
}

export function temporaryBotData({ botId, closeAfter }: TemporaryBotDataOptions = {}): SqlBotData {
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "test-world", scope: botId ? { kind: "bot", botId } : { kind: "shared" } },
  });
  closeAfter?.after(() => data.close());
  return data;
}

/**
 * A temp root for persistent stores, removed when the test ends. Every store
 * opened here, and anything registered with `alsoClose`, is closed first:
 * Windows refuses to remove a directory while a database still holds a file.
 */
export function persistentBotData(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), "mine-ai-bot-data-"));
  const closers: (() => void)[] = [];
  t.after(() => {
    for (const close of closers) close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    alsoClose(close: () => void) {
      closers.push(close);
    },
    open(worldId: string, scope: BotDataScope = { kind: "shared" }): SqlBotData {
      const data = SqlBotData.create({ storage: { kind: "persistent", root }, identity: { worldId, scope } });
      closers.push(() => data.close());
      return data;
    },
  };
}
