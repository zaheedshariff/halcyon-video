import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => void store.clear(),
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
};

const { fastBootReveal, FAST_BOOT_KEY } = await import('../src/fast-boot.ts');

beforeEach(() => store.clear());

test('fastBootReveal is off by default in a plain node harness', () => {
  assert.equal(fastBootReveal(), false);
});

test('fastBootReveal follows explicit bb_fast_boot=1', () => {
  localStorage.setItem(FAST_BOOT_KEY, '1');
  assert.equal(fastBootReveal(), true);
});

test('fastBootReveal follows explicit bb_fast_boot=0 even when otherwise eligible', () => {
  localStorage.setItem(FAST_BOOT_KEY, '0');
  assert.equal(fastBootReveal(), false);
});