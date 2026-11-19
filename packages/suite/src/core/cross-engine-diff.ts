/**
 * cross-engine-diff — 同一 caseId 在 Playwright / Cypress 下的首个分歧定位
 *
 * 输入已经归一化的用例结果；输出既可用于报告，也可用于批次看板聚合。
 * 对比顺序：case 是否存在 → verdict/reasonCode → 逐步执行签名。
 */

import type { ReasonCode, Verdict } from './verdict.js';

export interface DiffStep {
  stepId?: string | number;
  order?: number;
  action?: string;
  target?: string;
  expected?: string;
  verdict?: string;
  error?: string;
}

export interface DiffCaseResult {
  caseId: string;
  caseName?: string;
  title?: string;
  groupName?: string;
  groupPath?: string;
  verdict: Verdict;
  reasonCode?: ReasonCode;
  steps?: DiffStep[];
}

export type DiffType =
  | 'verdict_diff'
  | 'reason_diff'
  | 'step_diff'
  | 'case_missing_playwright'
  | 'case_missing_cypress'
  | 'consistent';

export interface StepDiff {
  index: number;
  stepId?: string | number;
  order?: number;
  playwright?: DiffStep;
  cypress?: DiffStep;
  fields: string[];
}

export interface CrossEngineDiffEntry {
  caseId: string;
  caseName: string;
  title: string;
  groupName: string;
  groupPath: string;
  displayName: string;
  playwright?: Pick<DiffCaseResult, 'verdict' | 'reasonCode'>;
  cypress?: Pick<DiffCaseResult, 'verdict' | 'reasonCode'>;
  consistent: boolean;
  diffType: DiffType;
  firstDiffStep?: StepDiff;
  suggestedCategory: 'product' | 'script' | 'infra' | 'env' | 'unsupported' | 'unknown';
}

export interface CrossEngineDiffReport {
  generatedAt: string;
  totals: {
    cases: number;
    consistent: number;
    inconsistent: number;
    missing: number;
  };
  byDiffType: Record<string, number>;
  entries: CrossEngineDiffEntry[];
}

function stepFields(step: DiffStep): Record<string, string> {
  return {
    action: String(step.action || ''),
    target: String(step.target || ''),
    expected: String(step.expected || ''),
    verdict: String(step.verdict || ''),
  };
}

function compareSteps(pwSteps: DiffStep[] | undefined, cySteps: DiffStep[] | undefined): StepDiff | undefined {
  const pw = Array.isArray(pwSteps) ? pwSteps : [];
  const cy = Array.isArray(cySteps) ? cySteps : [];
  const max = Math.max(pw.length, cy.length);
  for (let i = 0; i < max; i++) {
    const left = pw[i];
    const right = cy[i];
    if (!left || !right) {
      return {
        index: i,
        stepId: left?.stepId ?? right?.stepId,
        order: left?.order ?? right?.order,
        playwright: left,
        cypress: right,
        fields: left ? ['missing_cypress_step'] : ['missing_playwright_step'],
      };
    }

    const leftFields = stepFields(left);
    const rightFields = stepFields(right);
    const fields = Object.keys(leftFields).filter((key) => leftFields[key] !== rightFields[key]);
    if (fields.length) {
      return {
        index: i,
        stepId: left.stepId ?? right.stepId,
        order: left.order ?? right.order,
        playwright: left,
        cypress: right,
        fields,
      };
    }
  }
  return undefined;
}

function categoryOf(reasonCode?: ReasonCode): CrossEngineDiffEntry['suggestedCategory'] {
  if (!reasonCode) return 'unknown';
  if (reasonCode.startsWith('infra_')) return 'infra';
  if (reasonCode.startsWith('env_')) return 'env';
  if (reasonCode.startsWith('product_')) return 'product';
  if (reasonCode.startsWith('script_')) return 'script';
  if (reasonCode === 'unsupported_engine_capability') return 'unsupported';
  return 'unknown';
}

function buildEntry(
  caseId: string,
  pw: DiffCaseResult | undefined,
  cy: DiffCaseResult | undefined,
): CrossEngineDiffEntry {
  const source = pw || cy;
  const groupName = source?.groupName || '';
  const groupPath = source?.groupPath || '';
  const title = source?.title || '';
  const caseName = source?.caseName || '';
  const displayName = [groupName, caseId, title].filter(Boolean).join(' · ');

  if (!pw || !cy) {
    const diffType: DiffType = !pw ? 'case_missing_playwright' : 'case_missing_cypress';
    return {
      caseId,
      caseName,
      title,
      groupName,
      groupPath,
      displayName: displayName || caseId,
      playwright: pw && { verdict: pw.verdict, reasonCode: pw.reasonCode },
      cypress: cy && { verdict: cy.verdict, reasonCode: cy.reasonCode },
      consistent: false,
      diffType,
      suggestedCategory: 'infra',
    };
  }

  const firstDiffStep = compareSteps(pw.steps, cy.steps);
  let diffType: DiffType = 'consistent';
  if (pw.verdict !== cy.verdict) diffType = 'verdict_diff';
  else if (pw.reasonCode !== cy.reasonCode) diffType = 'reason_diff';
  else if (firstDiffStep) diffType = 'step_diff';

  const reason = pw.reasonCode !== cy.reasonCode ? (pw.reasonCode || cy.reasonCode) : (pw.reasonCode || cy.reasonCode);
  return {
    caseId,
    caseName,
    title,
    groupName,
    groupPath,
    displayName,
    playwright: { verdict: pw.verdict, reasonCode: pw.reasonCode },
    cypress: { verdict: cy.verdict, reasonCode: cy.reasonCode },
    consistent: diffType === 'consistent',
    diffType,
    ...(firstDiffStep ? { firstDiffStep } : {}),
    suggestedCategory: categoryOf(reason),
  };
}

export function buildCrossEngineDiffReport(
  playwrightCases: DiffCaseResult[],
  cypressCases: DiffCaseResult[],
  generatedAt = new Date().toISOString(),
): CrossEngineDiffReport {
  const pwMap = new Map((playwrightCases || []).map((item) => [String(item.caseId), item]));
  const cyMap = new Map((cypressCases || []).map((item) => [String(item.caseId), item]));
  const caseIds = Array.from(new Set([...pwMap.keys(), ...cyMap.keys()])).sort();

  const entries = caseIds.map((caseId) => buildEntry(caseId, pwMap.get(caseId), cyMap.get(caseId)));
  const byDiffType: Record<string, number> = {};
  for (const entry of entries) {
    byDiffType[entry.diffType] = (byDiffType[entry.diffType] || 0) + 1;
  }

  return {
    generatedAt,
    totals: {
      cases: entries.length,
      consistent: entries.filter((entry) => entry.consistent).length,
      inconsistent: entries.filter((entry) => !entry.consistent).length,
      missing: entries.filter((entry) => entry.diffType.startsWith('case_missing_')).length,
    },
    byDiffType,
    entries,
  };
}
