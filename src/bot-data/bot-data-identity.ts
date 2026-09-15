export type BotDataScope = { readonly kind: "shared" } | { readonly kind: "bot"; readonly botId: string };
export type BotDataScopeKind = BotDataScope["kind"];

export interface BotDataIdentity {
  readonly worldId: string;
  readonly scope: BotDataScope;
}

/** Parse storage-independent world and ownership identity without touching storage. */
export function resolveBotDataIdentity(identity: BotDataIdentity): BotDataIdentity {
  return Object.freeze({
    worldId: requireIdentity(identity.worldId, "worldId"),
    scope: copyScope(identity.scope),
  });
}

function copyScope(scope: BotDataScope): BotDataScope {
  if (scope.kind === "shared") return Object.freeze({ kind: "shared" });
  return Object.freeze({
    kind: "bot",
    botId: requireIdentity(scope.botId, "scope.botId"),
  });
}

function requireIdentity(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty.`);
  }
  return value;
}
