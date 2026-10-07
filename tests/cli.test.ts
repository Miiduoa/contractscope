import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BASELINE_SAMPLE, CANDIDATE_SAMPLE } from '../src/sample';

const directory = mkdtempSync(join(tmpdir(), 'contractscope-test-'));
const baseline = join(directory, 'baseline.json');
const candidate = join(directory, 'candidate.yaml');
writeFileSync(baseline, BASELINE_SAMPLE);
writeFileSync(candidate, CANDIDATE_SAMPLE);
const command = ['--import', 'tsx', resolve('src/cli/index.ts')];
const run = (...args: string[]) =>
  spawnSync(process.execPath, [...command, ...args], { encoding: 'utf8' });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('actual CLI process', () => {
  it('writes deterministic JSON and succeeds without a failure policy', () => {
    const a = run(baseline, candidate, '--json');
    const b = run(baseline, candidate, '--json');
    expect(a.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(JSON.parse(a.stdout).summary.breaking).toBe(6);
    expect(a.stderr).toBe('');
  });
  it('exits 1 for breaking changes with fail-on-breaking', () => {
    const result = run(baseline, candidate, '--fail-on-breaking');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('6 breaking');
  });
  it('exits 2 for incomplete coverage regardless of breaking policy', () => {
    const value = JSON.parse(BASELINE_SAMPLE);
    value.security = [{ bearer: [] }];
    const incomplete = join(directory, 'incomplete.json');
    writeFileSync(incomplete, JSON.stringify(value));
    for (const flag of [[], ['--fail-on-breaking']]) {
      const result = run(incomplete, candidate, '--json', ...flag);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).coverage).toBe('incomplete');
    }
  });
  it('exits 3 with no success report for parse, file, and usage errors', () => {
    const invalid = join(directory, 'invalid.yaml');
    writeFileSync(invalid, '{');
    for (const args of [
      [baseline, invalid],
      [baseline, join(directory, 'missing')],
      ['--unknown'],
      [],
    ]) {
      const result = run(...args);
      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Contractscope:');
    }
  });
  it('exits 0 for an unchanged contract and provides help', () => {
    expect(run(baseline, baseline, '--fail-on-breaking').status).toBe(0);
    expect(execFileSync(process.execPath, [...command, '--help'], { encoding: 'utf8' })).toContain(
      'Exit codes:',
    );
  });
});
