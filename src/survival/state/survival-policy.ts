import { setNavigationPolicyProvider } from "./navigation-policy.js";
import type { Bot } from "mineflayer";
import { randomUUID } from "node:crypto";
import type { CombatPolicy } from "../policy/combat/contract.js";
import {
  DEFAULT_SURVIVAL_POLICY,
  SURVIVAL_POLICY_PATHS,
  describeLifetime,
  flattenPolicyLeaves,
  type FoodPolicy,
  type PolicyCondition,
  type PolicyEdit,
  type PolicyOverride,
  type PolicySnapshot,
  type SurvivalPolicy,
} from "../policy/contract.js";

/**
 * One connection's survival policy: the defaults plus one override per field,
 * each carrying its own lifetime and the model's reason for it.
 *
 * Overrides are per field so a tactical edit never disturbs a standing one:
 * hiding switched off for one encounter leaves a session-long raw-food
 * setting exactly where it was, and expires on its own when the encounter
 * ends. Physical owners subscribe to reconcile; this class never drives controls.
 */
export class SurvivalPolicyState {
  readonly #connection = randomUUID();
  #revision = 0;
  #nextEncounter = 0;
  readonly #overrides = new Map<string, PolicyOverride>();
  #effective: SurvivalPolicy = DEFAULT_SURVIVAL_POLICY;
  readonly #arrowHunts = new Set<AbortSignal>();
  readonly #quarries = new Map<AbortSignal, string>();
  #encounter: string | null = null;
  #settling: Promise<void> | null = null;
  #lastChange = "Connection started with defaults.";
  #constraint: string | null = null;
  #response: PolicySnapshot["response"] = null;
  readonly #listeners = new Set<(snapshot: PolicySnapshot) => void | Promise<void>>();
  readonly #observers = new Set<(snapshot: PolicySnapshot) => void>();

  constructor(
    readonly bot: Bot,
    private readonly now: () => number = Date.now,
  ) {
    setNavigationPolicyProvider(bot, () => this.effective.navigation);
  }

  get effective(): Readonly<SurvivalPolicy> {
    if (!this.#arrowHunts.size) return this.#effective;
    return { ...this.#effective, combat: { ...this.#effective.combat, bow: false } };
  }
  /** The combat group, which is what every combat consumer reads. */
  get combat(): Readonly<CombatPolicy> {
    return this.effective.combat;
  }
  get food(): Readonly<FoodPolicy> {
    return this.effective.food;
  }
  /**
   * Species that admitted hunts are deliberately pursuing. Automatic contact
   * defence fights these instead of withdrawing from them: a hunt that walks
   * toward a skeleton and a reflex that runs from the same skeleton would
   * otherwise take turns owning the body until the request timed out.
   */
  get quarry(): readonly string[] {
    return [...new Set(this.#quarries.values())];
  }
  /** Declare a hunted species for as long as the hunt request lives. */
  declareQuarry(lifetime: AbortSignal, species: string): void {
    if (lifetime.aborted || this.#quarries.has(lifetime)) return;
    this.#quarries.set(lifetime, species);
    lifetime.addEventListener("abort", () => this.#quarries.delete(lifetime), { once: true });
  }
  /** An admitted arrow hunt must not spend its requested drop, even during defensive interruptions. */
  reserveArrows(lifetime: AbortSignal): void {
    if (lifetime.aborted || this.#arrowHunts.has(lifetime)) return;
    this.#arrowHunts.add(lifetime);
    lifetime.addEventListener("abort", () => this.#arrowHunts.delete(lifetime), { once: true });
  }
  get settling(): boolean {
    return this.#settling !== null;
  }
  snapshot(): PolicySnapshot {
    return structuredClone({
      revision: `${this.#connection}:${this.#revision}`,
      defaults: DEFAULT_SURVIVAL_POLICY,
      effective: this.effective,
      overrides: [...this.#overrides.values()].sort((left, right) => left.path.localeCompare(right.path)),
      encounter: this.#encounter,
      settling: this.settling,
      lastChange: this.#lastChange,
      constraint: this.#constraint,
      response: this.#response,
    });
  }
  onChange(listener: (snapshot: PolicySnapshot) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  observeResponse(response: PolicySnapshot["response"]): void {
    this.#response = response;
  }
  onObservation(listener: (snapshot: PolicySnapshot) => void): () => void {
    this.#observers.add(listener);
    return () => {
      this.#observers.delete(listener);
    };
  }
  constrain(reason: string | null): void {
    if (this.#constraint === reason) return;
    this.#constraint = reason;
    for (const observer of this.#observers) observer(this.snapshot());
  }
  beginEncounter(): string {
    return (this.#encounter ??= `${this.#connection}:encounter-${++this.#nextEncounter}`);
  }
  async endEncounter(): Promise<void> {
    this.#encounter = null;
    const ended = this.#drop((override) => override.lifetime.kind === "encounter");
    if (ended.length) await this.#commit(`Encounter ended; ${ended.join(", ")} restored to defaults.`);
  }
  async reset(reason: string): Promise<void> {
    this.#encounter = null;
    this.#overrides.clear();
    await this.#commit(reason);
  }
  /** Expire overrides whose condition now holds or whose time has run out. */
  async refresh(): Promise<void> {
    if (this.settling) return;
    const now = this.now();
    const ended = this.#drop(
      (override) =>
        (override.lifetime.kind === "until" && this.#condition(override.lifetime.condition)) ||
        (override.expiresAt !== null && now >= override.expiresAt),
    );
    if (ended.length) await this.#commit(`Lifetime ended for ${ended.join(", ")}; defaults restored.`);
  }
  async edit(request: PolicyEdit): Promise<PolicySnapshot> {
    if (request.expected_revision !== this.snapshot().revision)
      throw new Error("[POLICY_REVISION_STALE] Read the current survival policy before editing.");
    if (this.settling)
      throw new Error("[POLICY_SETTLING] The previous policy change is still releasing its physical response.");
    switch (request.operation) {
      case "reset":
        this.#overrides.clear();
        await this.#commit(`Model reset to defaults: ${request.reason}`);
        break;
      case "clear": {
        const unknown = request.paths.filter((path) => !SURVIVAL_POLICY_PATHS.has(path));
        if (unknown.length) throw new Error(`[POLICY_UNKNOWN_PATH] No policy field at ${unknown.join(", ")}.`);
        for (const path of request.paths) this.#overrides.delete(path);
        await this.#commit(`Model cleared ${request.paths.join(", ")}: ${request.reason}`);
        break;
      }
      case "set": {
        const leaves = flattenPolicyLeaves(request.changes);
        if (!leaves.length) throw new Error("[POLICY_EMPTY_CHANGE] The set names no fields.");
        const lifetime = request.lifetime;
        if (lifetime.kind === "encounter" && lifetime.encounter_id !== this.#encounter)
          throw new Error("[POLICY_ENCOUNTER_STALE] The named encounter is not active.");
        if (lifetime.kind === "until" && this.#condition(lifetime.condition))
          throw new Error("[POLICY_CONDITION_SATISFIED] The until condition is already satisfied.");
        const scaffoldBlocks = leaves.find(([path]) => path === "navigation.scaffold_blocks")?.[1];
        if (Array.isArray(scaffoldBlocks)) {
          const duplicate = scaffoldBlocks.find((name, index) => scaffoldBlocks.indexOf(name) !== index);
          if (duplicate)
            throw new Error(`[POLICY_SCAFFOLD_DUPLICATE] Scaffold block ${duplicate} is named more than once.`);
          const unknown = scaffoldBlocks.filter(
            (name) => !this.bot.registry.blocksByName[name] || !this.bot.registry.itemsByName[name],
          );
          if (unknown.length)
            throw new Error(`[POLICY_SCAFFOLD_UNKNOWN] No placeable block item is registered for ${unknown.join(", ")}.`);
        }
        const since = this.now();
        const expiresAt = lifetime.kind === "for" ? since + lifetime.duration_ms : null;
        for (const [path, value] of leaves)
          this.#overrides.set(path, { path, value: structuredClone(value), lifetime, reason: request.reason, since, expiresAt });
        await this.#commit(
          `Model set ${leaves.map(([path]) => path).join(", ")} ${describeLifetime(lifetime)}: ${request.reason}`,
        );
        break;
      }
    }
    return this.snapshot();
  }
  #drop(expired: (override: PolicyOverride) => boolean): string[] {
    const dropped: string[] = [];
    for (const [path, override] of this.#overrides) {
      if (!expired(override)) continue;
      this.#overrides.delete(path);
      dropped.push(path);
    }
    return dropped;
  }
  #condition(condition: PolicyCondition): boolean {
    return condition.kind === "health_at_least"
      ? this.bot.health >= condition.value
      : this.bot.inventory
          .items()
          .filter((item) => item.name === condition.item)
          .reduce((sum, item) => sum + item.count, 0) >= condition.count;
  }
  /** Defaults with every live override written over them; the clone is not frozen. */
  #compose(): SurvivalPolicy {
    const policy = structuredClone(DEFAULT_SURVIVAL_POLICY) as SurvivalPolicy;
    for (const override of this.#overrides.values()) {
      const segments = override.path.split(".");
      let target = policy as unknown as Record<string, unknown>;
      for (const segment of segments.slice(0, -1)) target = target[segment] as Record<string, unknown>;
      target[segments[segments.length - 1]!] = Array.isArray(override.value)
        ? Object.freeze(structuredClone(override.value))
        : override.value;
    }
    Object.freeze(policy.navigation.scaffold_blocks);
    return policy;
  }
  async #commit(reason: string): Promise<void> {
    if (this.#settling) await this.#settling.catch(() => {});
    this.#effective = this.#compose();
    this.#revision++;
    this.#lastChange = reason;
    this.#constraint = null;
    // Defer listeners until the admission barrier is visible, including to physics observers.
    const pending = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.#listeners].map(async (listener) => listener(this.snapshot())));
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failures.length) throw new AggregateError(failures, "Policy applied, but physical reconciliation failed.");
    });
    this.#settling = pending;
    try {
      await pending;
    } finally {
      if (this.#settling === pending) this.#settling = null;
      for (const observer of this.#observers) observer(this.snapshot());
    }
  }
}
