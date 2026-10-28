import { describe, expect, it } from 'vitest';
import { persistentJson, persistentRequest, persistentValue } from '@/lib/plugin-persistent-storage';
import type { PluginJson } from '@/lib/plugin-persistent-storage';

describe('persistent JSON contract', () => {
  it('requires observed revisions and rejects extra identity/namespace selectors', () => {
    expect(persistentRequest({ operation: 'set', key: 'k', value: null, expectedRevision: null })).toEqual({ operation: 'set', key: 'k', value: null, expectedRevision: null });
    expect(() => persistentRequest({ operation: 'set', key: 'k', value: 'x' })).toThrow('invalid');
    expect(() => persistentRequest({ operation: 'keys', accountName: 'other' })).toThrow('invalid');
    expect(() => persistentRequest({ operation: 'get', key: 'k', pluginId: 'other' })).toThrow('invalid');
  });

  it.each([undefined, NaN, Infinity, new Date(), new Array(2)])('rejects non-JSON input: %s', (value) => {
    expect(() => persistentJson(value)).toThrow('invalid');
  });

  it('rejects cycles, symbols and excessive depth but preserves inert prototype-named JSON members', () => {
    const cycle: { self?: object } = {};
    cycle.self = cycle;
    expect(() => persistentJson(cycle)).toThrow('invalid');
    expect(() => persistentJson({ [Symbol('field')]: 'x' })).toThrow('invalid');
    let nested: PluginJson = null;
    for (let depth = 0; depth < 34; depth += 1) nested = [nested];
    expect(() => persistentJson(nested)).toThrow('invalid');
    const inert = JSON.parse('{"__proto__":{"safe":"data"}}');
    expect(persistentJson(inert)).toEqual(inert);
    expect(Object.getPrototypeOf(inert)).toBe(Object.prototype);
  });

  it('enforces actual UTF-8 bytes for multibyte values', () => {
    expect(() => persistentValue('한'.repeat(90000))).toThrow('quota');
  });
});
