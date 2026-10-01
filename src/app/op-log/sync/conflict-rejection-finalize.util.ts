import type { VectorClock } from '../core/operation.types';
import { OpLog } from '../../core/log';
import type { KeptTimeDeltas } from './conflict-disjoint-merge.util';

interface ConflictFinalizeStore {
  markRejected: (opIds: string[]) => Promise<unknown>;
  rebasePendingLocalOps: (
    opIds: readonly string[],
    clockToDominate: VectorClock,
  ) => Promise<unknown>;
}

/**
 * Last write of a conflict resolution, after every chosen resolution entered
 * state: marks the losing local and remote ops rejected, then moves the time
 * deltas kept beside a remote win (#10408) past their winners in place (id,
 * seq and payload stay), so each uploads once and replays once.
 *
 * The rebase runs in its own transaction. If the app stops between the two,
 * the delta stays pending with its old clock; its upload then fails with
 * CONFLICT_CONCURRENT and `SupersededOperationResolverService`
 * (`rebaseCommutingTimeDeltaRejections`) rebases it: a round trip, not a loss.
 *
 * Like the `markRejected` calls, the rebase runs under the caller's
 * OPERATION_LOG lock only, not UPLOAD: it touches only ops the rejections
 * above would otherwise have rejected.
 */
export const finalizeConflictRejections = async (
  store: ConflictFinalizeStore,
  {
    localOpIds,
    remoteOpIds,
    kept,
  }: {
    localOpIds: string[];
    remoteOpIds: string[];
    kept: KeptTimeDeltas;
  },
): Promise<void> => {
  for (const [side, opIds] of [
    ['local', localOpIds],
    ['remote', remoteOpIds],
  ] as const) {
    if (opIds.length > 0) {
      await store.markRejected(opIds);
      OpLog.normal(
        `ConflictResolutionService: Marked ${opIds.length} ${side} ops as rejected`,
      );
    }
  }
  // Skips the store when nothing was kept: the rebase opens a write transaction.
  if (kept.opIds.size > 0) {
    await store.rebasePendingLocalOps([...kept.opIds], kept.clockToDominate);
  }
};
