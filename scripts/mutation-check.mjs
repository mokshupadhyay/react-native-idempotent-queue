// Mutation check for the property tests. For each property: back up the
// source file, apply one small deliberate break, run that property and expect
// it to FAIL, restore the backup, and confirm with `cmp` that the source is
// byte-identical to the backup. Run with `node scripts/mutation-check.mjs`.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jest = require.resolve('jest/bin/jest');

const mutations = [
  {
    property: 'property 1',
    description: 'Do not recover inflight items on start',
    file: 'src/queue.ts',
    find: "if (item.status === 'inflight') {",
    replace: "if (false && item.status === 'inflight') {",
  },
  {
    property: 'property 2',
    description: 'Drop the in-flight key guard when picking due items',
    file: 'src/queue.ts',
    find: 'if (inflightKeys.has(item.key) || claimedKeys.has(item.key)) return;',
    replace: 'if (claimedKeys.has(item.key)) return;',
  },
  {
    property: 'property 3',
    description: 'Off-by-one in the maxAttempts check (`>=` becomes `>`)',
    file: 'src/queue.ts',
    find: '} else if (current.attempts >= policy.maxAttempts) {',
    replace: '} else if (current.attempts > policy.maxAttempts) {',
  },
  {
    property: 'property 4',
    description: 'Skip persisting the attempt before send',
    file: 'src/queue.ts',
    find: '      // The attempt is counted on disk before the request leaves.\n      try {\n        await save();',
    replace: '      // The attempt is counted on disk before the request leaves.\n      try {\n        void save;',
  },
  {
    property: 'property 1',
    description: 'Drop the dedupe by key in enqueue',
    file: 'src/queue.ts',
    find: '      if (existing) return existing;',
    replace: '      if (existing && false) return existing;',
  },
  {
    property: 'property 4',
    description: 'Resolve enqueue without persisting the item',
    file: 'src/queue.ts',
    find: 'const write = save();',
    replace: 'const write = Promise.resolve();',
  },
  {
    property: 'property 5',
    test: 'property 5.*holds for any classifier output',
    description: "Accept a classifier's delayMs without clamping it",
    file: 'src/queue.ts',
    find: '  const delay = clampRetryDelay(delayMs);',
    replace: "  const delay = typeof delayMs === 'number' && !Number.isNaN(delayMs) ? delayMs : undefined;",
  },
  {
    property: 'property 5',
    test: 'property 5.*holds for any classifier output',
    description: 'Drop the lower bound of a classifier delay, so -Infinity gets through',
    file: 'src/backoff.ts',
    find: 'return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, Math.round(value)));',
    replace: 'return Math.min(MAX_RETRY_DELAY_MS, Math.round(value));',
  },
  {
    property: 'property 5',
    test: 'property 5.*storage layer never writes',
    description: 'Store a write without decoding it first',
    file: 'src/persistence.ts',
    find: '      if (!check.ok) throw new Error(',
    replace: '      if (false && !check.ok) throw new Error(',
  },
];

const backupDir = mkdtempSync(join(tmpdir(), 'idempotent-queue-mutation-'));
const results = [];

for (const [index, mutation] of mutations.entries()) {
  const backup = join(backupDir, `${index}-${mutation.file.replace(/\//g, '_')}`);
  copyFileSync(mutation.file, backup);
  const source = readFileSync(mutation.file, 'utf8');
  const occurrences = source.split(mutation.find).length - 1;
  if (occurrences !== 1) throw new Error(`${mutation.description}: expected 1 match, found ${occurrences}`);
  let run;
  try {
    writeFileSync(mutation.file, source.replace(mutation.find, mutation.replace));
    run = spawnSync(
      process.execPath,
      [jest, 'src/__tests__/properties.test.ts', '-t', mutation.test || mutation.property, '--ci'],
      { encoding: 'utf8', env: { ...process.env, NUM_RUNS: process.env.NUM_RUNS || '120' } },
    );
  } finally {
    copyFileSync(backup, mutation.file);
  }
  // `cmp` exits non-zero (and execFileSync throws) if the restore is not byte-identical.
  execFileSync('cmp', [mutation.file, backup]);
  const output = `${run.stdout}\n${run.stderr}`;
  const failed = run.status !== 0;
  const after = (output.match(/Property failed after (\d+) tests/) || [])[1];
  const counterexample = (output.match(/Counterexample: (.*)/) || [])[1];
  const cause = (output.match(/Cause:\s*\n\s*(.*)\n(?:[\s\S]*?\n\s*(Expected.*)\n\s*(Received.*))?/) || []).slice(1, 4);
  results.push({ ...mutation, failed, after, counterexample, cause: cause.filter(Boolean).join(' / ') });
  console.log(
    `${mutation.property}: ${mutation.description}\n` +
      `  property ${failed ? 'FAILED as expected' : 'PASSED (mutation survived)'}` +
      (after ? ` after ${after} cases` : '') +
      `\n  cause: ${results[results.length - 1].cause}\n` +
      `  counterexample: ${counterexample}\n` +
      `  restored: cmp ${mutation.file} ${backup} -> identical\n`,
  );
}

const clean = spawnSync(process.execPath, [jest, 'src/__tests__/properties.test.ts', '--ci'], { encoding: 'utf8' });
console.log(`unmutated properties: ${clean.status === 0 ? 'all pass' : 'FAIL'}`);
writeFileSync(join(backupDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(`results: ${join(backupDir, 'results.json')}`);
if (results.some((result) => !result.failed) || clean.status !== 0) process.exit(1);
