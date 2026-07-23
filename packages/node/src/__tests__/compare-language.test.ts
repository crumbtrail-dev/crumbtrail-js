import { describe, expect, it } from 'vitest';
import { buildRegressionContext } from '../compare/regression-context';
import { formatComparisonSummary, renderCompareReport } from '../compare/report';
import { CLEAN_FIXTURE, REGRESSION_FIXTURE } from './compare-report.test';

const BANNED: Array<{ label: string; pattern: RegExp }> = [
  { label: 'local positioning', pattern: new RegExp(`\\b${'local'}[- ]${'first'}\\b`, 'i') },
  { label: 'data/machine claim', pattern: new RegExp(`\\b${'data'} ${'never'} ${'leaves'} (?:your|the) ${'machine'}\\b`, 'i') },
  { label: 'nothing/machine claim', pattern: new RegExp(`\\b${'nothing'} ${'leaves'} (?:your|the) ${'machine'}\\b`, 'i') },
  { label: 'category framing', pattern: new RegExp(`\\b${'error'}[- ]${'tracking'}\\b`, 'i') },
  { label: 'Jam comparison', pattern: new RegExp(`\\b${'lighter'} than ${'jam'}\\b`, 'i') },
  { label: 'session-capture claim', pattern: new RegExp(`\\b${'nobody'} (?:else )?does ${'session'} ${'capture'}\\b`, 'i') },
  { label: 'self-host claim', pattern: new RegExp(`\\b${'nobody'} (?:else )?does ${'self'}[- ]${'host'}(?:ing)?\\b`, 'i') },
];

function assertClean(text: string): void {
  for (const { label, pattern } of BANNED) {
    expect(text, `banned phrase in output: ${label}`).not.toMatch(pattern);
  }
}

describe('positioning language on compare surfaces', () => {
  it('report renderer output contains no banned phrases', () => {
    assertClean(renderCompareReport(REGRESSION_FIXTURE));
    assertClean(renderCompareReport(CLEAN_FIXTURE));
  });

  it('CLI summary output contains no banned phrases', () => {
    assertClean(formatComparisonSummary(REGRESSION_FIXTURE));
    assertClean(formatComparisonSummary(CLEAN_FIXTURE));
  });

  it('regression-context hints contain no banned phrases', async () => {
    const ctx = await buildRegressionContext(REGRESSION_FIXTURE, '/nonexistent-session-dir');
    assertClean(JSON.stringify(ctx.causal_window?.hints ?? []) + ctx.repro_hint);
  });
});
