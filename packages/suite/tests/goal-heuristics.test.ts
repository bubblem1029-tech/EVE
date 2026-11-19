import { describe, expect, it } from 'vitest';
import { inferConclusionFromDoneText, isSsoRedirectUrl } from '../src/core/judge/goal-heuristics.js';

describe('inferConclusionFromDoneText', () => {
  it('treats bare fail keywords as failures', () => {
    expect(inferConclusionFromDoneText('fail')).toBe('fail');
    expect(inferConclusionFromDoneText('failure: button not updated')).toBe('fail');
    expect(inferConclusionFromDoneText('FAILED')).toBe('fail');
    expect(inferConclusionFromDoneText('AssertionError: expected 1 to be 2')).toBe('fail');
  });

  it('infers blocked before fail/pass', () => {
    expect(inferConclusionFromDoneText('blocked: SSO redirect')).toBe('blocked');
    expect(inferConclusionFromDoneText('无访问权限')).toBe('blocked');
  });

  it('passes explicit successful conclusions', () => {
    expect(inferConclusionFromDoneText('验证通过')).toBe('pass');
    expect(inferConclusionFromDoneText('Task completed successfully')).toBe('pass');
  });

  it('returns undefined for missing or empty text', () => {
    expect(inferConclusionFromDoneText(undefined)).toBeUndefined();
    expect(inferConclusionFromDoneText('')).toBeUndefined();
    expect(inferConclusionFromDoneText('   ')).toBeUndefined();
  });
});

describe('isSsoRedirectUrl', () => {
  it('detects CAS login redirects without treating normal product pages as SSO', () => {
    expect(isSsoRedirectUrl('https://sso.corp.kuaishou.com/cas/login?service=x')).toBe(true);
    expect(isSsoRedirectUrl('https://login.corp.kuaishou.com/')).toBe(true);
    expect(isSsoRedirectUrl('https://kwaibi.corp.kuaishou.com/home')).toBe(false);
    expect(isSsoRedirectUrl('https://kwaibi.corp.kuaishou.com/login-help')).toBe(false);
  });
});
