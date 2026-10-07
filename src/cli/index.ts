import { readFile, stat } from 'node:fs/promises';
import { compareContracts, MAX_INPUT_BYTES, type Report } from '../core/index.js';

const help = `Contractscope — conservative OpenAPI comparison

Usage: npm run diff -- <baseline.json|yaml> <candidate.json|yaml> [options]

  --json               Write a deterministic JSON report to stdout
  --fail-on-breaking   Exit 1 when a complete report contains breaking changes
  --help               Show this help

Exit codes: 0 complete report; 1 breaking with --fail-on-breaking;
            2 incomplete coverage (always); 3 invalid input or invocation.
Files are limited to 512 KiB each. References are local only.
`;

export function formatText(report: Report): string {
  const lines = [
    `Contractscope: ${report.status.toUpperCase()}`,
    `${report.baseline.title} ${report.baseline.version} -> ${report.candidate.title} ${report.candidate.version}`,
    `${report.summary.breaking} breaking | ${report.summary.compatible} compatible changes | ${report.summary.warnings} coverage warnings`,
    `Coverage: ${report.coverage}`,
  ];
  for (const change of report.changes)
    lines.push(
      '',
      `[${change.severity.toUpperCase()}] ${change.operation}: ${change.title}`,
      `  ${change.location}`,
      `  ${change.rationale}`,
      `  ${change.before ?? '—'} -> ${change.after ?? '—'}`,
    );
  for (const warning of report.warnings)
    lines.push('', `[UNREVIEWED] ${warning.source} ${warning.location}`, `  ${warning.message}`);
  if (!report.changes.length && !report.warnings.length)
    lines.push('', 'No changes detected by the supported structural rules.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(help);
    return;
  }
  const unknown = args.find(
    (arg) => arg.startsWith('--') && !['--json', '--fail-on-breaking'].includes(arg),
  );
  const files = args.filter((arg) => !arg.startsWith('--'));
  if (unknown || files.length !== 2)
    throw new Error(unknown ? `Unknown option: ${unknown}\n${help}` : help);
  const contents: string[] = [];
  for (const file of files) {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error(`${file}: expected a regular file.`);
    if (metadata.size > MAX_INPUT_BYTES)
      throw new Error(`${file}: exceeds the 512 KiB input limit.`);
    contents.push(await readFile(file, 'utf8'));
  }
  const report = compareContracts(contents[0], contents[1]);
  process.stdout.write(
    args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatText(report),
  );
  process.exitCode =
    report.coverage === 'incomplete'
      ? 2
      : args.includes('--fail-on-breaking') && report.summary.breaking > 0
        ? 1
        : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Contractscope: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 3;
});
