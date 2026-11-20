import { describe, expect, it } from 'vitest';
import { buildConfidenceRecord, type StepResultAttachment } from '../src/core/judge/confidence.js';

function blockedStep(diagnostics: any): StepResultAttachment {
  return {
    step: '点击时间选择框',
    expected: '时间选择面板弹出',
    order: 21,
    success: false,
    conclusion: 'blocked',
    actions: [{ tool: 'done', verdict: 'blocked', text: '' }],
    diagnostics,
  } as StepResultAttachment;
}

const healthyNetwork = { total: 88, failed: 0, http4xx: 0, http5xx: 0, slow: 0, samples: [] };

function diagnosticsWith(overrides: { network?: any; browser?: any }): any {
  return {
    performance: {
      totalMs: 1000,
      aiReasoningMs: 900,
      actionMs: 0,
      networkMs: 100,
      page: { longTaskCount: 0, longTaskMs: 0 },
    },
    ai: { llmCalls: 4, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    network: { ...healthyNetwork, ...(overrides.network || {}) },
    browser: {
      consoleErrors: 0,
      consoleWarnings: 0,
      pageErrors: 0,
      uncaughtExceptions: 0,
      samples: [],
      ...(overrides.browser || {}),
    },
    quality: { retries: 0, recoveries: 0, repeatedActionCount: 0, verdictConflict: false, riskReasons: [] },
  };
}

describe('buildConfidenceRecord app error attribution', () => {
  it('maps agent-blocked with a page TypeError to product_app_error', () => {
    const { record } = buildConfidenceRecord({
      title: 'S157: 列--指标上轴、删除（源 DSL 转译）',
      status: 'failed',
      error: null,
      steps: [blockedStep(diagnosticsWith({
        network: healthyNetwork,
        browser: {
          consoleErrors: 3,
          consoleWarnings: 28,
          pageErrors: 0,
          uncaughtExceptions: 1,
          samples: [{
            level: 'error',
            kind: 'console',
            text: "TypeError: Cannot read properties of undefined (reading 'filter')",
          }],
        },
      }))],
    });
    expect(record.errorCategory).toBe('env');
    expect(record.verdict).toBe('blocked');
    expect(record.reasonCode).toBe('product_app_error');
    expect(record.thought).toContain('页面运行时异常');
  });

  it('keeps network failures as env_network_unreachable', () => {
    const { record } = buildConfidenceRecord({
      title: 'S1: network down',
      status: 'failed',
      error: null,
      steps: [blockedStep(diagnosticsWith({
        network: { ...healthyNetwork, http5xx: 4, failed: 2 },
        browser: {
          consoleErrors: 1,
          consoleWarnings: 0,
          pageErrors: 0,
          uncaughtExceptions: 1,
          samples: [{ level: 'error', kind: 'console', text: 'TypeError: x is undefined' }],
        },
      }))],
    });
    expect(record.reasonCode).toBe('env_network_unreachable');
  });
});
