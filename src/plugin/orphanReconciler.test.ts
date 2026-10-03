import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrphanReconciler, type OrphanDeps } from './orphanReconciler';

function setup(initial: { referenced?: string[]; owned?: string[] } = {}) {
  const referenced = new Set(initial.referenced ?? []);
  const owned = new Set(initial.owned ?? ['a']);
  const pending = new Set<string>();
  const calls: string[] = [];
  const deps: OrphanDeps = {
    isOwned: (id) => owned.has(id),
    isPending: (id) => pending.has(id),
    findReferenced: async (ids) => new Set([...ids].filter((i) => referenced.has(i))),
    addPending: async (id) => {
      calls.push(`add:${id}`);
      pending.add(id);
    },
    removePending: async (id) => {
      calls.push(`remove:${id}`);
      pending.delete(id);
    },
    onError: vi.fn(),
    graceMs: 5000,
    restoreMs: 400,
  };
  return { r: new OrphanReconciler(deps), referenced, pending, calls, deps };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('OrphanReconciler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lists an owned file once nothing references it after the grace period', async () => {
    const { r, calls } = setup();
    r.touched(['a'], []);
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await settle();
    expect(calls).toEqual(['add:a']);
  });

  it('does not list while another note (or the same note) still references it', async () => {
    const { r, calls } = setup({ referenced: ['a'] });
    r.touched(['a'], []);
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toEqual([]);
  });

  it('ignores files the plugin did not upload', async () => {
    const { r, calls } = setup({ owned: [] });
    r.touched(['foreign'], []);
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toEqual([]);
  });

  it('undo within the grace period cancels the pending listing', async () => {
    const { r, referenced, calls } = setup();
    r.touched(['a'], []); // deleted
    await vi.advanceTimersByTimeAsync(1000);
    referenced.add('a'); // undo puts it back
    r.touched([], ['a']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
  });

  it('undo after listing delists the file, redo lists it again', async () => {
    const { r, referenced, calls } = setup();
    r.touched(['a'], []);
    await vi.advanceTimersByTimeAsync(5100);
    expect(calls).toEqual(['add:a']);

    referenced.add('a'); // undo
    r.touched([], ['a']);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(['add:a', 'remove:a']);

    referenced.delete('a'); // redo
    r.touched(['a'], []);
    await vi.advanceTimersByTimeAsync(5100);
    expect(calls).toEqual(['add:a', 'remove:a', 'add:a']);
  });

  it('a cut-and-paste move (removed then re-added) never lists it', async () => {
    const { r, referenced, calls } = setup({ referenced: ['a'] });
    r.touched(['a'], []);
    r.touched([], ['a']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
    expect(referenced.has('a')).toBe(true);
  });

  it('removing one of two embeds of the same image keeps the file', async () => {
    const { r, calls } = setup({ referenced: ['a'] });
    r.touched(['a'], []);
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toEqual([]);
  });

  it('does nothing if references cannot be determined', async () => {
    const { r, calls, deps } = setup();
    deps.findReferenced = async () => {
      throw new Error('vault unreadable');
    };
    r.touched(['a'], []);
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toEqual([]);
  });

  it('reports errors and leaves state unchanged so a later edit can retry', async () => {
    const { r, pending, deps } = setup();
    deps.addPending = async () => {
      throw new Error('503');
    };
    r.touched(['a'], []);
    await vi.advanceTimersByTimeAsync(5100);
    expect(deps.onError).toHaveBeenCalledWith('add', 'a', expect.any(Error));
    expect(pending.size).toBe(0);
  });

  it('dispose cancels pending work', async () => {
    const { r, calls } = setup();
    r.touched(['a'], []);
    r.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
  });
});
