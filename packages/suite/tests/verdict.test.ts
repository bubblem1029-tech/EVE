import { describe, expect, it } from 'vitest';
import { isInfraReason, normalizeVerdict } from '../src/core/verdict.js';

describe('normalizeVerdict', () => {
  it('maps 429 to infra_llm_429', () => {
    const result = normalizeVerdict({
      status: 'failed',
      errorCategory: 'env',
      error: 'Request failed: 429 Too Many Requests',
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasonCode).toBe('infra_llm_429');
    expect(isInfraReason(result.reasonCode)).toBe(true);
  });

  it('maps cypress startup failures to engine init', () => {
    const result = normalizeVerdict({
      status: 'failed',
      errorCategory: 'env',
      error: 'Cypress verify failed: browser not found',
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasonCode).toBe('infra_engine_init_failed');
  });

  it('maps selector failures to script, not product failure', () => {
    const result = normalizeVerdict({
      status: 'failed',
      errorCategory: 'script',
      error: 'locator("#missing").click: element not found',
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasonCode).toBe('script_target_missing');
  });

  it('keeps true assertion failures as product failures', () => {
    const result = normalizeVerdict({
      status: 'failed',
      errorCategory: 'assert',
      error: 'AssertionError: expect(received).toBe(expected)',
    });
    expect(result.verdict).toBe('fail');
    expect(result.reasonCode).toBe('product_assert_failed');
  });

  it('maps SSO blocks to env and skips as skipped', () => {
    expect(normalizeVerdict({
      status: 'failed',
      errorCategory: 'env',
      error: 'SSO redirect to login page',
    }).reasonCode).toBe('env_sso_blocked');

    expect(normalizeVerdict({ status: 'skipped' }).verdict).toBe('skipped');
  });

  it('never returns blocked without a reason', () => {
    const result = normalizeVerdict({ status: 'unknown', errorCategory: 'unknown' });
    expect(result.verdict).toBe('blocked');
    expect(result.reasonCode).toBeTruthy();
  });

  it('does not turn evidence-less agent pass into a green result', () => {
    const result = normalizeVerdict({
      status: 'failed',
      errorCategory: 'pass',
      data: '阻塞',
      agentConclusion: 'pass',
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasonCode).toBe('script_evidence_missing');

    expect(normalizeVerdict({
      status: 'failed',
      errorCategory: 'pass',
      data: '通过（AI复核）',
      agentConclusion: 'pass',
    }).verdict).toBe('pass');
  });

});
