import { ApiError, responseApi } from '../api';

/** Keeps an uncertain mutation tied to its original payload and request ID. */
export class LifecycleIntent {
  pending: { path: string; body: unknown; key: string; stage: string; signature: string } | null = null;
  async submit<T>(path: string, body: unknown, stage: string): Promise<T> {
    const signature = JSON.stringify({ path, body, stage });
    if (this.pending && this.pending.signature !== signature) throw new Error('Retry the uncertain request before changing this action.');
    const request = this.pending ?? { path, body: JSON.parse(JSON.stringify(body)) as unknown, stage, signature, key: crypto.randomUUID() };
    this.pending = request;
    try {
      const result = await responseApi.post<T>(request.path, request.body, request.key);
      this.pending = null;
      return result;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status > 0 && failure.status < 500) this.pending = null;
      throw failure;
    }
  }
}

export function reviewedFiles(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Use a JSON object mapping each reviewed path to its complete file contents.');
  const entries = Object.entries(parsed);
  if (!entries.length || entries.length > 64 || entries.some(([name, value]) => !name || typeof value !== 'string')) throw new Error('Select 1–64 files with string contents.');
  const encoder = new TextEncoder();
  if (entries.some(([, value]) => encoder.encode(value).length > 262144)
      || entries.reduce((sum, [, value]) => sum + encoder.encode(value).length, 0) > 1048576) throw new Error('Reviewed selection exceeds the candidate byte budget.');
  return Object.fromEntries(entries);
}
