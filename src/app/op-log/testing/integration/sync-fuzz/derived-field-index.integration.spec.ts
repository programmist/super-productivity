import { TestBed } from '@angular/core/testing';
import { ReducerManager } from '@ngrx/store';
import { OperationLogStoreService } from '../../../persistence/operation-log-store.service';
import { convertOpToAction } from '../../../apply/operation-converter.util';
import { ActionType, Operation } from '../../../core/operation.types';
import {
  derivedChangesFor,
  derivedEntityKeys,
  diffEntityWrites,
} from '../../../sync/derived-field-index';
import { NOISE_FIELDS } from '../../../sync/conflict-disjoint-merge.util';
import { TaskSharedActions } from '../../../../root-store/meta/task-shared.actions';
import { executeIntent, fuzzDay, Intent, SETUP_INTENTS } from './sync-fuzz-actions';
import { FuzzDevice, SyncFuzzHarness } from './sync-fuzz-harness';

/**
 * Option (6) spike, exit criteria 1–3 (#10393), on the real store and the
 * fuzz harness's real producers. These pin what a state diff can and cannot
 * see; they are evidence, not behaviour to keep.
 */
describe('option (6) spike: derived field sets', () => {
  afterEach(() => SyncFuzzHarness.dispose());

  const setup = async (): Promise<{
    harness: SyncFuzzHarness;
    a: FuzzDevice;
    b: FuzzDevice;
  }> => {
    const harness = await SyncFuzzHarness.create();
    const a = await harness.addDevice('A');
    const b = await harness.addDevice('B');
    for (const intent of SETUP_INTENTS) {
      await harness.as(a, () => executeIntent(harness, intent));
    }
    for (const device of [a, b]) await harness.sync(device);
    return { harness, a, b };
  };

  const pendingOps = (): Promise<Operation[]> =>
    TestBed.inject(OperationLogStoreService)
      .getUnsynced()
      .then((entries) => entries.map((entry) => entry.op));

  const realFields = (fields: Record<string, unknown> | undefined): string[] =>
    Object.keys(fields ?? {}).filter((field) => !NOISE_FIELDS.has(field));

  /** What device `device` derives for `op` from its own current state. */
  const deriveOn = (
    harness: SyncFuzzHarness,
    device: FuzzDevice,
    op: Operation,
    stateOverride?: (root: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Map<string, Record<string, unknown>>> =>
    harness.as(device, async () => {
      const before = await harness.state();
      const base = stateOverride ? stateOverride(before) : before;
      const reduce = TestBed.inject(ReducerManager).getValue();
      return diffEntityWrites(base, reduce(base, convertOpToAction(op)));
    });

  const run = (harness: SyncFuzzHarness, device: FuzzDevice, intent: Intent): unknown =>
    harness.as(device, () => executeIntent(harness, intent));

  it('criterion 1: the synced habit count op writes an equal value, so its capture diff is empty', async () => {
    const { harness, a, b } = await setup();
    await run(harness, a, ['countHabit', 'h1']);
    const setOp = await harness.as(a, async () => {
      const op = (await pendingOps()).find(
        (o) => o.actionType === ActionType.COUNTER_SET_TODAY,
      )!;
      // The local, unsynced increase already wrote the count; the synced set
      // re-writes the same value, which no diff can see.
      expect(realFields(derivedChangesFor(op.id, 'SIMPLE_COUNTER', 'h1'))).toEqual([]);
      return op;
    });
    // The receiver, whose count is still the old one, sees a write: the two
    // devices derive different field sets for the same op.
    const onB = await deriveOn(harness, b, setOp);
    expect(realFields(onB.get('SIMPLE_COUNTER:h1'))).toEqual(['countOnDay']);
  });

  it('criterion 2: one auto-plan op writes the task and the TODAY tag', async () => {
    const { harness, a } = await setup();
    // t3 is an unscheduled project task: tracking it plans it for today.
    await run(harness, a, ['track', 't3', 2000]);
    await harness.as(a, async () => {
      const plan = (await pendingOps()).find(
        (o) => o.actionType === ActionType.TASK_SHARED_PLAN_FOR_TODAY,
      )!;
      expect(plan.entityIds ?? [plan.entityId]).toEqual(['t3']);
      expect(derivedEntityKeys(plan.id)).toEqual(
        jasmine.arrayContaining(['TASK:t3', 'TAG:TODAY']),
      );
      expect(realFields(derivedChangesFor(plan.id, 'TASK', 't3'))).toContain('dueDay');
      // The synced time delta's reducer runs only for remote ops: locally the
      // capture diff sees nothing, so the index cannot replace the delta rule.
      const delta = (await pendingOps()).find(
        (o) => o.actionType === ActionType.TIME_TRACKING_SYNC_TIME_SPENT,
      )!;
      expect(realFields(derivedChangesFor(delta.id, 'TASK', 't3'))).toEqual([]);
    });
  });

  it("criterion 3: what a dueDay edit writes besides the task depends on the applying device's day", async () => {
    const { harness, a, b } = await setup();
    // t3 is an unscheduled project task; A schedules it for its today.
    const day = fuzzDay();
    await harness.as(a, () =>
      harness.dispatch(
        TaskSharedActions.updateTask({ task: { id: 't3', changes: { dueDay: day } } }),
      ),
    );
    const op = await harness.as(a, async () => (await pendingOps()).at(-1)!);
    const withDay = (todayStr: string) => (root: Record<string, unknown>) => ({
      ...root,
      appState: { ...(root['appState'] as Record<string, unknown>), todayStr },
    });
    const sameDay = await deriveOn(harness, b, op, withDay(day));
    const nextDay = await deriveOn(harness, b, op, withDay('2999-01-01'));
    // The task's own fields agree; the other entities written do not: on the
    // same day the TODAY list gains t3, on another day a planner day does
    // (not a diffed slice), so the TODAY write is missing.
    expect(realFields(sameDay.get('TASK:t3'))).toEqual(
      realFields(nextDay.get('TASK:t3')),
    );
    expect(sameDay.has('TAG:TODAY')).toBeTrue();
    expect(nextDay.has('TAG:TODAY')).toBeFalse();
  });
});
