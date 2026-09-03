// Test setup for Vitest
import { vi } from 'vitest';

// Mock global utilities
global.describe = describe;
global.it = it;
global.test = test;
global.expect = expect;
global.vi = vi;

// Mock console for tests
global.console = {
  ...console,
  // Uncomment to ignore specific logs in tests
  // log: vi.fn(),
  // warn: vi.fn(),
  // error: vi.fn(),
};