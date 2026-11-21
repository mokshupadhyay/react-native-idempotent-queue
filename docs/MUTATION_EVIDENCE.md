# Mutation evidence

Each property test was checked against one small deliberate break in `src/queue.ts`. `scripts/mutation-check.mjs` does the following for each row:

1. copies the file to a backup in a temporary directory;
2. applies the one-line change shown;
3. runs only that property (`jest src/__tests__/properties.test.ts -t "<property>"`, 120 generated cases);
4. restores the file from the backup;
5. runs `cmp <file> <backup>`, which stops the script if the restored file is not byte-identical.

After all rows it runs the unmutated property suite again. Run it with `node scripts/mutation-check.mjs`.

Result of the recorded run: every mutation made its property fail, every `cmp` reported identical files, the unmutated properties all passed, and the script exited 0. Separately, a SHA-256 of all 21 files in `src/` and `src/__tests__/` was taken before the run and checked after it, and all 21 matched.

| # | Property | Deliberate break (`src/queue.ts`) | Property result | Failing check | Shrunk counterexample | Restored, `cmp` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1. Every enqueued key ends applied exactly once and `succeeded` | Do not recover inflight items on start: `if (item.status === 'inflight') {` → `if (false && item.status === 'inflight') {` | FAILED after 9 cases | Expected status `"succeeded"`, received `"inflight"` | Enqueue `key-0`, then crash while it is in flight | identical |
| 2 | 1. Every enqueued key ends applied exactly once and `succeeded` | Drop the dedupe by key: `if (existing) return existing;` → `if (existing && false) return existing;` | FAILED after 5 cases | Expected 1 item for the key, received 2 | Enqueue `key-5` twice | identical |
| 3 | 2. The same key is never in flight twice at once | Drop the in-flight key guard: `if (inflightKeys.has(item.key) \|\| claimedKeys.has(item.key)) return;` → `if (claimedKeys.has(item.key)) return;` | FAILED after 1 case | Expected at most 1 request per key in flight, received 2 | Concurrency 2: enqueue `key-0`, then discard it while in flight and enqueue the same key again | identical |
| 4 | 3. Permanent errors never retried; retryable errors at most `maxAttempts` times | Off by one: `current.attempts >= policy.maxAttempts` → `current.attempts > policy.maxAttempts` | FAILED after 3 cases | Expected at most 1 send (`maxAttempts: 1`), received 2 | `maxAttempts: 1`, enqueue `key-0`, every response is HTTP 500 | identical |
| 5 | 4. Reloading from storage gives the same items as the live queue | Skip persisting before send: `await save();` (before `send`) → `void save;` | FAILED after 1 case | The reloaded item was `pending` with `attempts: 0`; the live item, an interrupted last attempt, should reload as `failed` with `attempts: 1` | Enqueue `key-0` and let it start | identical |
| 6 | 4. Reloading from storage gives the same items as the live queue | Resolve enqueue without persisting: `const write = save();` → `const write = Promise.resolve();` | FAILED after 2 cases | Reloaded items differ from the live items (an enqueued item is missing) | Enqueue `key-0`, then `key-1` | identical |

## Notes

- Case counts and counterexamples depend on fast-check's random seed, so a new run can report different numbers. Every row fails within the 120 cases on every run seen so far.
- A property that never meets the situation it guards would pass without testing anything. To prevent that, each property counts the situations its generated cases reached (crash mid-flight, lost response, response lost to going offline, re-enqueue while the discarded request is still in flight, `dead` and `failed` items, comparison while stopped, and others). The test fails if any count stays at zero. `SHOW_COVERAGE=1 npx jest src/__tests__/properties.test.ts` prints the counts.
- Property 2 found a real bug while it was being written. A duplicate `enqueue` waited for the first item's write. Meanwhile the first item was discarded and its key enqueued again, and the waiting duplicate then created a second item with the same key, which could run in parallel with the first. The fix re-checks the key after every wait, and the due-item scan never picks two items with the same key. `src/__tests__/queue.test.ts` has a regression test ("creates one item when a duplicate enqueue outlives a discard of the first") that fails without the fix. This was checked by reverting the fix, watching the test fail, restoring the file and running `cmp`.
