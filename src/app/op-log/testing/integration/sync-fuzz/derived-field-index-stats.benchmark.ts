import { getLookupCounts, resetLookupCounts } from '../../../sync/derived-field-index';
import { SyncFuzzHarness } from './sync-fuzz-harness';
import { FUZZ_PROFILES } from './sync-fuzz-profiles';
import { runFuzz } from './sync-fuzz-runner';
import { keepKarmaAlive } from './sync-fuzz-shrink';

/**
 * Option (6) spike: over the signature report's 120 seeds, how the derived
 * field index served each opaque-op lookup in conflict resolution, per action
 * type: from this device's capture diff, from an incoming op derived at
 * resolve time, empty (an equal-value write or no write on that entity), or
 * missed (no entry, e.g. after a restart). Runs only when named.
 */
describe('option (6) spike: derived field index lookups', () => {
  afterEach(() => SyncFuzzHarness.dispose());

  it('reports lookups per action type', async () => {
    resetLookupCounts();
    for (const weights of Object.values(FUZZ_PROFILES)) {
      for (let seed = 20725000; seed < 20725030; seed++) {
        keepKarmaAlive(seed);
        await runFuzz({ seed, stepCount: 30, weights });
      }
    }
    fail(`DERIVED_STATS_START${JSON.stringify(getLookupCounts())}DERIVED_STATS_END`);
  }, 3_600_000);
});
