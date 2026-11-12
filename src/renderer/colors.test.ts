import { describe, it, expect } from 'vitest';
import { STATUS, tint } from './colors';

describe('tint', () => {
  it('converts a hex status color into the exact rgba() strings used in the UI', () => {
    expect(tint(STATUS.success, 0.1)).toBe('rgba(80, 192, 131, 0.1)');
    expect(tint(STATUS.success, 0.15)).toBe('rgba(80, 192, 131, 0.15)');
    expect(tint(STATUS.danger, 0.1)).toBe('rgba(208, 77, 92, 0.1)');
    expect(tint(STATUS.danger, 0.3)).toBe('rgba(208, 77, 92, 0.3)');
    expect(tint(STATUS.warning, 0.15)).toBe('rgba(252, 196, 25, 0.15)');
    expect(tint(STATUS.linked, 0.15)).toBe('rgba(81, 207, 102, 0.15)');
  });
});
