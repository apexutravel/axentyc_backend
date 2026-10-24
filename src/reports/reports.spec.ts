import { BadRequestException } from '@nestjs/common';
import { median, resolveRange } from './reports.service';

describe('reports helpers', () => {
  it('median handles empty, odd and even sets', () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  it('default range is the last 30 days', () => {
    const now = new Date('2026-10-22T00:00:00Z');
    const { start, end } = resolveRange(undefined, undefined, now);
    expect(Math.round((end.getTime() - start.getTime()) / 86400000)).toBe(30);
  });
  it('rejects inverted, invalid and oversized ranges', () => {
    expect(() => resolveRange('2026-10-22', '2026-10-01')).toThrow(BadRequestException);
    expect(() => resolveRange('nope', '2026-10-01')).toThrow(BadRequestException);
    expect(() => resolveRange('2020-01-01', '2026-10-01')).toThrow(BadRequestException);
  });
});
