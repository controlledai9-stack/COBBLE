import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOperatorToken } from '../api';
import { LifecycleIntent, reviewedFiles } from './lifecycle';

describe('exact lifecycle requests', () => {
  beforeEach(() => { vi.stubGlobal('window', new EventTarget()); setOperatorToken('synthetic'); });
  afterEach(() => { setOperatorToken(''); vi.unstubAllGlobals(); });
  it('preserves an uncertain approval request and refuses substitution', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(new Response('{"approval_id":"apr-one"}'));
    vi.stubGlobal('fetch', fetch);
    const intent = new LifecycleIntent();
    const body = { action: { target: 'reviewed-target' } };
    await expect(intent.submit('/approvals', body, 'approve')).rejects.toThrow();
    const pending = intent.pending!;
    body.action.target = 'changed-target';
    expect((pending.body as typeof body).action.target).toBe('reviewed-target');
    await expect(intent.submit('/releases', body, 'dispatch')).rejects.toThrow('uncertain request');
    await intent.submit(pending.path, pending.body, pending.stage);
    expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(fetch.mock.calls[1][1].headers['Idempotency-Key']);
    expect(intent.pending).toBeNull();
  });
  it('clears a definite revision conflict so a new reviewed intent can be prepared', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"detail":"revision changed"}', { status: 409 })));
    const intent = new LifecycleIntent();
    await expect(intent.submit('/quarantines/one/release-intent', {}, 'preview')).rejects.toThrow('revision changed');
    expect(intent.pending).toBeNull();
  });
  it('requires a bounded explicit map of reviewed complete file outcomes', () => {
    expect(reviewedFiles('{"solution.py":"return 42\\n"}')).toEqual({ 'solution.py': 'return 42\n' });
    for (const value of ['{}', '[]', '{"source":42}', JSON.stringify({ source: 'x'.repeat(262145) })]) {
      expect(() => reviewedFiles(value)).toThrow();
    }
  });
});
