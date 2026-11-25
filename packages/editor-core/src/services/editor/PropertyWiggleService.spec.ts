import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configNumber, Script, type PropertyDefinition } from '@pix3/runtime';

import type { OperationEvent, OperationEventListener } from '@/services/core/OperationService';
import { isWiggleable, PropertyWiggleService, type WiggleTarget } from './PropertyWiggleService';

type Guard = <T>(read: () => T) => T;

class TestScript extends Script {}

function makeService() {
  const service = new PropertyWiggleService();
  const listeners = new Set<OperationEventListener>();
  const guards = new Set<Guard>();
  const requestRender = vi.fn();
  Object.defineProperty(service, 'viewport', { value: { requestRender } });
  Object.defineProperty(service, 'operations', {
    value: {
      addListener: (l: OperationEventListener) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
  });
  Object.defineProperty(service, 'flush', {
    value: {
      guardAuthored: (g: Guard) => {
        guards.add(g);
        return () => guards.delete(g);
      },
    },
  });
  const fire = (event: OperationEvent) => listeners.forEach(l => l(event));
  const readAuthored = <T>(read: () => T): T => {
    let run = read;
    for (const g of guards) {
      const inner = run;
      run = () => g(inner);
    }
    return run();
  };
  return { service, fire, readAuthored, requestRender, listeners, guards };
}

const strength: PropertyDefinition = configNumber('strength', 'Strength', 0.5, {
  min: 0,
  max: 1,
  step: 0.01,
});

function target(component: Script, base = 0.5): WiggleTarget {
  return {
    key: 'c1:strength',
    holder: component,
    isComponent: true,
    propDef: strength,
    spec: { kind: 'number', base, min: 0, max: 1, step: 0.01 },
  };
}

describe('PropertyWiggleService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('swings the live value, then puts the exact authored config back (absent stays absent)', () => {
    const { service, requestRender } = makeService();
    const component = new TestScript('c1', 'user:Test');
    component.config = {};
    service.toggle(target(component));
    vi.advanceTimersByTime(400);
    expect(component.config.strength).not.toBeUndefined();
    expect(component.config.strength).not.toBe(0.5);
    expect(requestRender).toHaveBeenCalled();

    vi.advanceTimersByTime(3000); // level 1 ends by itself
    expect(service.state).toBeNull();
    expect('strength' in component.config).toBe(false);
  });

  it('a flush reads the authored value while the wiggle runs', () => {
    const { service, readAuthored } = makeService();
    const component = new TestScript('c1', 'user:Test');
    component.config = { strength: 0.5 };
    service.toggle(target(component));
    vi.advanceTimersByTime(400);
    const live = component.config.strength;
    expect(live).not.toBe(0.5);
    expect(readAuthored(() => component.config.strength)).toBe(0.5);
    expect(component.config.strength).toBe(live);
    service.stop();
  });

  it('any operation restores before it performs; selection does not', () => {
    const { service, fire, listeners, guards } = makeService();
    const component = new TestScript('c1', 'user:Test');
    component.config = { strength: 0.5 };
    service.toggle(target(component));
    vi.advanceTimersByTime(400);
    const metadata = (id: string) => ({ id, title: id, description: '', tags: [] }) as never;
    fire({ type: 'operation:invoked', metadata: metadata('scene.select-object'), timestamp: 0 });
    expect(service.state).not.toBeNull();
    fire({
      type: 'operation:invoked',
      metadata: metadata('scripts.update-component-property'),
      timestamp: 0,
    });
    expect(service.state).toBeNull();
    expect(component.config.strength).toBe(0.5);
    expect(listeners.size).toBe(0);
    expect(guards.size).toBe(0);
  });

  it('same label: level 1 → level 2 (loops) → stop; another label retargets', () => {
    const { service } = makeService();
    const component = new TestScript('c1', 'user:Test');
    component.config = { strength: 0.5, other: 0.2 };
    expect(service.toggle(target(component))).toBe(1);
    expect(service.toggle(target(component))).toBe(2);
    vi.advanceTimersByTime(10_000);
    expect(service.state?.level).toBe(2);
    expect(service.toggle(target(component))).toBeNull();
    expect(component.config.strength).toBe(0.5);

    service.toggle(target(component));
    vi.advanceTimersByTime(300);
    const other: WiggleTarget = {
      ...target(component, 0.2),
      key: 'c1:other',
      propDef: configNumber('other', 'Other', 0.2, { min: 0, max: 1 }),
    };
    expect(service.toggle(other)).toBe(1);
    expect(component.config.strength).toBe(0.5);
    service.stop();
    expect(component.config.other).toBe(0.2);
  });

  it('wiggles numbers, booleans and colours unless the schema opts out', () => {
    expect(isWiggleable(strength)).toBe(true);
    expect(isWiggleable({ ...strength, ui: { wiggle: false } })).toBe(false);
    expect(isWiggleable({ ...strength, type: 'string' })).toBe(false);
    expect(isWiggleable({ ...strength, type: 'color' })).toBe(true);
  });
});
