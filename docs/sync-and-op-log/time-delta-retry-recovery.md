# Time-delta upload receipt recovery

## Reproduction and scope

SuperSync can store a time delta while its upload response is lost. The local
operation remains pending. Download conflict resolution then rebases its clock,
and uploading the same ID with that changed clock returns `INVALID_OP_ID`.
The stored-response case in
`e2e/tests/sync/supersync-time-delta-upload-retry.spec.ts` reproduces this through
the real immediate uploader, encrypted server, interrupted response, and reload.

Removing the eager rebase is not sufficient. With v19.1.0, the server can accept
the original concurrent delta without rejecting it. The released receiver then
emits a task replacement whose clock covers that delta but whose time omits it.
The current client applies the replacement and loses its contribution. Both
[run 37215666835](https://github.com/super-productivity/super-productivity/actions/runs/37215666835)
and [run 37217202348](https://github.com/super-productivity/super-productivity/actions/runs/37217202348)
show this loss. A local reproduction after removing only the eager rebase also
confirmed an acknowledged local delta followed by that released replacement.
Both released-client directions pass on the reverted baseline.

## Recovery contract

Recovery is limited to a `syncTimeSpent` delta rejected with `INVALID_OP_ID`.
An authenticated, decrypted server operation must have the same ID and authored
content; the local clock must strictly dominate its stored clock. A mismatched
payload, author, entity, or other operation field is not an acknowledgement.

The local acknowledgement restores the stored operation's clock atomically with
its synced marker. It preserves the operation ID, sequence, payload, and replay
count. The global and state-cache clocks retain their learned causal history.
The receipt lookup must neither apply downloaded operations nor advance the
normal download cursor. Network or decryption failure must not permanently
reject an operation merely because its receipt could not be checked.
The lookup scans retained server pages only after this rejection; ordinary
uploads do not perform it. Recovery requires finding the matching original.

This uses existing server responses and operation shapes. It adds no persisted
field, sync-wire field, schema version, or plugin API. It does not relax the
server's duplicate-identity validation, and it does not recover arbitrary ID
collisions or historical time already lost to conflict resolution.

## Validation requirements

- Stored and rejected uploads whose responses are lost, including reloads and
  a fresh receiver; tracked time and task content must survive.
- v19.1.0 concurrent unscheduled-task tracking in both conflict directions.
- Mismatched receipts and interrupted lookups must not acknowledge different
  content or discard pending work.
- Atomic acknowledgement, unchanged replay order, and unchanged global clocks.
- Focused upload/persistence tests and the unchanged sync-fuzz comparison
  against the reverted baseline.

## Validation results

Validated locally on 2026-10-04 against reverted baseline `cea86337a9`:

- The final stored-response E2E fails on the baseline with a permanent upload
  rejection and passes with this fix, including reloads and a fresh receiver.
- All seven focused browser cases pass: both lost-response cases, three
  current-client unscheduled-task crossings, and both v19.1.0 directions.
- Upload tests pass (98), acknowledgement tests pass (5), and sync orchestrator
  tests pass (188). The stored-response E2E also passes after the final review fix.
- Sync-fuzz comparison reports no newly failing signatures across 120 seeds;
  all 120 execute identical step counts on the baseline and working tree.
- App/spec TypeScript checks, modified TypeScript file checks, and diff whitespace
  checks pass. The separate E2E TypeScript check encounters a pre-existing
  unresolved `src/app/core/util/vector-clock` import from
  `compact-operation.types.ts`, reached through existing E2E tests.

## Review

A fresh-context review found a race when two tabs acknowledge the same deferred
receipt. The second acknowledgement could fail after the first restored the
original clock. A failing regression test preceded the fix: an already-synced,
unrejected local entry with exactly the original content and clock is now a
no-op. Different content remains rejected. The reviewer independently verified
all five acknowledgement tests.

The review also corrected an orchestrator test expectation and verified that
original receipts reach acknowledgement after piggyback processing. No concrete
review findings remain unresolved. Receipt recovery remains limited to originals
still available in retained server history.
