// Obsidian-free core of the "pending Drive deletions" list.
//
// The editor reports which Drive file IDs were touched by an edit (disappeared
// from, or appeared in, the text). This class never trusts that as the answer:
// after a short delay it re-checks whether ANY note still references the id and
// then converges the pending list to match (unreferenced → added, referenced
// again → removed). Nothing here talks to Drive; deletion is a separate,
// user-triggered step. Because it reconciles
// against the truth rather than replaying events, undo/redo, cut-and-paste moves
// and the same image being embedded in several notes all fall out correctly.

export interface OrphanDeps {
  /** True only for files this plugin uploaded (never touch foreign Drive files). */
  isOwned: (id: string) => boolean;
  /** True if the id is already on the pending-deletion list. */
  isPending: (id: string) => boolean;
  /** Of `ids`, return those still referenced by some note right now. */
  findReferenced: (ids: Set<string>) => Promise<Set<string>>;
  addPending: (id: string) => Promise<void>;
  removePending: (id: string) => Promise<void>;
  onError: (action: 'add' | 'remove', id: string, err: unknown) => void;
  /** Wait after a removal before listing it, so cut/paste moves and quick edits don't churn. */
  graceMs: number;
  /** Wait after a re-appearance (undo) before delisting. */
  restoreMs: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class OrphanReconciler {
  private readonly timers = new Map<string, unknown>();
  private readonly due = new Set<string>();
  private flushHandle: unknown = null;
  // Per-id promise chain so an add never races an in-flight remove (or vice versa).
  private readonly chains = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly deps: OrphanDeps) {}

  /** An edit removed `removed` ids from, and added `added` ids to, a note. */
  touched(removed: Iterable<string>, added: Iterable<string>): void {
    for (const id of removed) this.arm(id, this.deps.graceMs);
    // An id both removed and added in one edit (e.g. a move) takes the shorter wait.
    for (const id of added) this.arm(id, this.deps.restoreMs);
  }

  dispose(): void {
    this.disposed = true;
    const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as number));
    for (const h of this.timers.values()) clear(h);
    if (this.flushHandle !== null) clear(this.flushHandle);
    this.timers.clear();
    this.due.clear();
  }

  private arm(id: string, ms: number): void {
    if (!this.deps.isOwned(id) && !this.deps.isPending(id)) return;
    const set = this.deps.setTimer ?? ((fn, t) => setTimeout(fn, t));
    const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as number));
    const existing = this.timers.get(id);
    if (existing !== undefined) clear(existing);
    this.timers.set(
      id,
      set(() => {
        this.timers.delete(id);
        this.due.add(id);
        this.scheduleFlush();
      }, ms),
    );
  }

  // Coalesce ids that come due together into one vault scan.
  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    const set = this.deps.setTimer ?? ((fn, t) => setTimeout(fn, t));
    this.flushHandle = set(() => {
      this.flushHandle = null;
      void this.flush();
    }, 0);
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.due.size === 0) return;
    const ids = new Set(this.due);
    this.due.clear();

    let referenced: Set<string>;
    try {
      referenced = await this.deps.findReferenced(ids);
    } catch {
      return; // Can't tell what is referenced: do nothing rather than guess.
    }
    if (this.disposed) return;

    for (const id of ids) {
      const inUse = referenced.has(id);
      if (!inUse && !this.deps.isPending(id) && this.deps.isOwned(id)) {
        this.chain(id, 'add', () => this.deps.addPending(id));
      } else if (inUse && this.deps.isPending(id)) {
        this.chain(id, 'remove', () => this.deps.removePending(id));
      }
    }
  }

  private chain(id: string, action: 'add' | 'remove', fn: () => Promise<void>): void {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev
      .then(() => {
        // Re-check at run time: the world may have moved on while we were queued.
        if (action === 'add' && this.deps.isPending(id)) return;
        if (action === 'remove' && !this.deps.isPending(id)) return;
        return fn();
      })
      .catch((err) => this.deps.onError(action, id, err))
      .finally(() => {
        if (this.chains.get(id) === next) this.chains.delete(id);
      });
    this.chains.set(id, next);
  }
}
