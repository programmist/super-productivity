import { finalizeConflictRejections } from './conflict-rejection-finalize.util';

describe('finalizeConflictRejections', () => {
  const createStore = (): jasmine.SpyObj<{
    markRejected: (opIds: string[]) => Promise<unknown>;
    rebasePendingLocalOps: (opIds: readonly string[], clock: object) => Promise<unknown>;
  }> => {
    const store = jasmine.createSpyObj('store', [
      'markRejected',
      'rebasePendingLocalOps',
    ]);
    store.markRejected.and.resolveTo();
    store.rebasePendingLocalOps.and.resolveTo();
    return store;
  };

  it('rejects both sides, then rebases the kept deltas past their winners', async () => {
    const store = createStore();
    await finalizeConflictRejections(store, {
      localOpIds: ['local-done'],
      remoteOpIds: ['remote-loser'],
      kept: { opIds: new Set(['local-delta']), clockToDominate: { A: 5 } },
    });
    expect(store.markRejected.calls.allArgs()).toEqual([
      [['local-done']],
      [['remote-loser']],
    ]);
    expect(store.rebasePendingLocalOps).toHaveBeenCalledOnceWith(['local-delta'], {
      A: 5,
    });
    expect(store.markRejected).toHaveBeenCalledBefore(store.rebasePendingLocalOps);
  });

  it('skips every empty write', async () => {
    const store = createStore();
    await finalizeConflictRejections(store, {
      localOpIds: [],
      remoteOpIds: [],
      kept: { opIds: new Set(), clockToDominate: {} },
    });
    expect(store.markRejected).not.toHaveBeenCalled();
    expect(store.rebasePendingLocalOps).not.toHaveBeenCalled();
  });
});
