/**
 * SPIKE (option 6 of docs/sync-and-op-log/protocol-change-options.md, #10393
 * queue item 4). Not production code: an in-memory, never-synced index of the
 * fields an op wrote, learned by diffing root state instead of reading the
 * op's payload.
 *
 * - This device's own ops: the capture meta-reducer diffs the state before and
 *   after the action (`recordActionWrites`), and the persist effect binds the
 *   diff to the op id (`bindOpWrites`).
 * - Incoming ops in a conflict: the resolver applies the op's action to a copy
 *   of its current root state and diffs (`deriveIncomingWrites`). Incoming
 *   LWW resolution rows are never indexed (D9); they are readable anyway.
 *
 * `derivedChangesFor` is consulted only where `extractOpChanges` would call an
 * op opaque, so the existing per-field machinery reads the derived fields as
 * if the op had carried `{ id, changes }`.
 *
 * Known limits the spike measures rather than solves: a write of an equal
 * value is invisible to a diff; created and deleted entities are not
 * recorded; the index is lost on restart; it is not pruned on compaction.
 */
import { deepEqual } from '@sp/sync-core';

/** The adapter slices diffed, by entity type. */
export const DIFFED_SLICES: Readonly<Record<string, string>> = {
  TASK: 'tasks',
  PROJECT: 'projects',
  TAG: 'tag',
  NOTE: 'note',
  SIMPLE_COUNTER: 'simpleCounter',
};

/** `${entityType}:${entityId}` → the top-level fields written, with their new values. */
export type EntityWrites = Map<string, Record<string, unknown>>;

interface Slice {
  entities?: Record<string, Record<string, unknown> | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The fields each existing entity changed between two root states. An entity
 * that only exists on one side (created or deleted) is skipped.
 */
export const diffEntityWrites = (before: unknown, after: unknown): EntityWrites => {
  const writes: EntityWrites = new Map();
  if (!isRecord(before) || !isRecord(after)) return writes;
  for (const [entityType, sliceKey] of Object.entries(DIFFED_SLICES)) {
    const a = before[sliceKey] as Slice | undefined;
    const b = after[sliceKey] as Slice | undefined;
    if (!a?.entities || !b?.entities || a.entities === b.entities) continue;
    for (const [id, next] of Object.entries(b.entities)) {
      const prev = a.entities[id];
      if (!prev || !next || prev === next) continue;
      const fields: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (!deepEqual(prev[key], next[key])) fields[key] = next[key];
      }
      if (Object.keys(fields).length > 0) writes.set(`${entityType}:${id}`, fields);
    }
  }
  return writes;
};

const actionWrites = new WeakMap<object, EntityWrites>();
let opWrites = new Map<string, EntityWrites>();
const incomingOpIds = new Set<string>();

/** Spike measurement: per action type, how opaque-op lookups were served. */
export interface LookupCounts {
  capture: number;
  emptyCapture: number;
  incoming: number;
  emptyIncoming: number;
  miss: number;
}
type LookupKind = keyof LookupCounts;
/** `${opId}|${entityId}` → [actionType, how its latest lookup was served]. */
const lookups = new Map<string, [string, LookupKind]>();

export const getLookupCounts = (): Record<string, LookupCounts> => {
  const counts: Record<string, LookupCounts> = {};
  for (const [actionType, kind] of lookups.values()) {
    counts[actionType] ??= {
      capture: 0,
      emptyCapture: 0,
      incoming: 0,
      emptyIncoming: 0,
      miss: 0,
    };
    counts[actionType][kind]++;
  }
  return counts;
};

export const resetLookupCounts = (): void => lookups.clear();

/**
 * Records how a lookup was served; the latest lookup of an op and entity
 * wins, since the resolver checks opacity before it derives. LWW rows are
 * never indexed (D9) and are not counted.
 */
export const countOpaqueLookup = (
  op: { id: string; actionType: string },
  entityId: string,
  derived: Record<string, unknown> | undefined,
): void => {
  if (!isEnabled || op.actionType.endsWith('LWW Update')) return;
  const empty = !derived || Object.keys(derived).length === 0;
  const kind: LookupKind = !opWrites.has(op.id)
    ? 'miss'
    : incomingOpIds.has(op.id)
      ? empty
        ? 'emptyIncoming'
        : 'incoming'
      : empty
        ? 'emptyCapture'
        : 'capture';
  lookups.set(`${op.id}|${entityId}`, [op.actionType, kind]);
};

let isEnabled = true;

/** For the spike's A/B runs and specs. */
export const setDerivedFieldIndexEnabled = (enabled: boolean): void => {
  isEnabled = enabled;
};

export const isDerivedFieldIndexEnabled = (): boolean => isEnabled;

/** Called by the capture meta-reducer for this device's own persistent actions. */
export const recordActionWrites = (
  action: object,
  before: unknown,
  after: unknown,
): void => {
  if (!isEnabled || before === after) return;
  actionWrites.set(action, diffEntityWrites(before, after));
};

/** Called by the persist effect once the op for `action` has its id. */
export const bindOpWrites = (opId: string, action: object): void => {
  const writes = actionWrites.get(action);
  if (writes) opWrites.set(opId, writes);
};

/** Indexes an incoming op's writes against `before` (the resolver's state). */
export const deriveIncomingWrites = (
  opId: string,
  before: unknown,
  apply: (state: unknown) => unknown,
): void => {
  if (!isEnabled || opWrites.has(opId)) return;
  opWrites.set(opId, diffEntityWrites(before, apply(before)));
  incomingOpIds.add(opId);
};

/** The fields `opId` wrote on one entity, or undefined if it is not indexed. */
export const derivedChangesFor = (
  opId: string,
  entityType: string,
  entityId: string,
): Record<string, unknown> | undefined => {
  if (!isEnabled) return undefined;
  const writes = opWrites.get(opId);
  if (!writes) return undefined;
  return { ...(writes.get(`${entityType}:${entityId}`) ?? {}) };
};

/** Every entity `opId` wrote, for the multi-entity evidence (criterion 2). */
export const derivedEntityKeys = (opId: string): string[] | undefined => {
  const writes = opWrites.get(opId);
  return writes ? [...writes.keys()] : undefined;
};

/**
 * Swaps in another device's index and returns the current one. Only the fuzz
 * harness uses it: its devices share one JS context.
 */
export const swapDerivedFieldIndex = (
  next: Map<string, EntityWrites>,
): Map<string, EntityWrites> => {
  const previous = opWrites;
  opWrites = next;
  return previous;
};

/** Drops the whole index: a restart loses it (criterion 4). */
export const resetDerivedFieldIndex = (): void => {
  opWrites.clear();
};

/**
 * Indexes the incoming, otherwise opaque single-entity ops of a batch of
 * conflicts against the resolver's current root state (`reduce` is the root
 * reducer with its meta-reducers; the action is marked remote, so capture
 * skips it). `isOpaque` is `isOpaqueChangeOp` as the caller sees it.
 */
export const deriveIncomingConflictWrites = <
  T extends { id: string; entityIds?: string[] },
>(
  remoteOps: T[],
  rootState: unknown,
  reduce: (state: unknown, op: T) => unknown,
  isOpaque: (op: T) => boolean,
): void => {
  if (!isEnabled) return;
  for (const op of remoteOps) {
    if ((op.entityIds?.length ?? 1) > 1 || !isOpaque(op)) continue;
    try {
      deriveIncomingWrites(op.id, rootState, (state) => reduce(state, op));
    } catch {
      // A reducer that throws on a copy leaves the op opaque.
    }
  }
};
