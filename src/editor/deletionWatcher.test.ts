import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { analyzeTransaction } from './deletionWatcher';

const A = '![](https://lh3.googleusercontent.com/d/AAA111)';
const B = '![](https://lh3.googleusercontent.com/d/BBB222)';

describe('analyzeTransaction', () => {
  it('reports a deleted Drive embed as removed', () => {
    const state = EditorState.create({ doc: `intro\n${A}\noutro` });
    const tr = state.update({ changes: { from: 6, to: 6 + A.length, insert: '' }, userEvent: 'delete.selection' });
    const t = analyzeTransaction(tr);
    expect([...t!.removed]).toEqual(['AAA111']);
    expect(t!.added.size).toBe(0);
  });

  it('reports a re-inserted embed (undo) as added', () => {
    const state = EditorState.create({ doc: 'intro\n\noutro' });
    const tr = state.update({ changes: { from: 6, insert: A }, userEvent: 'undo' });
    expect([...analyzeTransaction(tr)!.added]).toEqual(['AAA111']);
  });

  it('ignores edits without a user event (file load, sync, plugin rewrites)', () => {
    const state = EditorState.create({ doc: A });
    const tr = state.update({ changes: { from: 0, to: A.length, insert: 'other note' } });
    expect(analyzeTransaction(tr)).toBeNull();
  });

  it('ignores edits that keep the same file id (alt text, url format change)', () => {
    const state = EditorState.create({ doc: A });
    const tr = state.update({ changes: { from: 2, insert: 'alt' }, userEvent: 'input.type' });
    expect(analyzeTransaction(tr)).toBeNull();
  });

  it('treats breaking the URL by backspacing into it as removal', () => {
    const state = EditorState.create({ doc: A });
    const tr = state.update({ changes: { from: 30, to: 31, insert: '' }, userEvent: 'delete.backward' });
    expect([...analyzeTransaction(tr)!.removed]).toEqual(['AAA111']);
  });

  it('does not report untouched embeds elsewhere in the note', () => {
    const state = EditorState.create({ doc: `${A}\nplain text\n${B}` });
    const at = A.length + 1;
    const tr = state.update({ changes: { from: at, to: at + 5, insert: '' }, userEvent: 'delete.backward' });
    expect(analyzeTransaction(tr)).toBeNull();
  });
});
