import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, responseApi, setOperatorToken } from './api';

describe('operator API boundary', () => {
  beforeEach(() => { vi.stubGlobal('window', new EventTarget()); setOperatorToken(''); });
  afterEach(() => { setOperatorToken(''); vi.unstubAllGlobals(); });
  it('adds the in-memory token and preserves the supplied mutation identity', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{"state":"confirmed"}'));
    vi.stubGlobal('fetch', fetch);
    setOperatorToken('synthetic-token');
    await responseApi.post('/messages/msg-one/review', { verdict: 'confirm' }, 'request-identity');
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/response/messages/msg-one/review');
    expect(init.headers.Authorization).toBe('Bearer synthetic-token');
    expect(init.headers['Idempotency-Key']).toBe('request-identity');
    expect(init.cache).toBe('no-store');
    setOperatorToken('');
    await api.runs();
    expect(fetch.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });
  it('rejects late protected responses after disconnect instead of exposing old data', async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
    setOperatorToken('synthetic-token');
    const request = responseApi.get('/review-queue');
    setOperatorToken('');
    complete(new Response('{"restricted":"old session"}'));
    await expect(request).rejects.toThrow('Operator session changed');
  });
});
