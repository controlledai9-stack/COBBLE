import { describe, expect, it } from 'vitest';
import { evidenceText, pathId } from './response';

describe('response evidence', () => {
  it('makes terminal and bidi control sequences visible without interpreting markup', () => {
    expect(evidenceText('\u001b[31m\u202e<img src=x>')).toBe('\\u001b[31m\\u202e<img src=x>');
    expect(evidenceText({ content: '<script>alert(1)</script>' })).toContain('<script>');
    expect(pathId('agent/a?run=other')).toBe('agent%2Fa%3Frun%3Dother');
  });
});
