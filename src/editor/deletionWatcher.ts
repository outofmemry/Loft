import { EditorView } from '@codemirror/view';
import type { Extension, Transaction } from '@codemirror/state';
import { findDriveLinks } from './driveEmbeds';

// CodeMirror extension that reports which Drive file IDs an edit made disappear
// from, or appear in, the document. It only looks at the lines each change
// touches, so cost is proportional to the edit, not the note.
//
// Only user-driven transactions count (typing, deleting, cut, paste, drag,
// undo, redo). Obsidian loading a file into the editor, external sync updates
// and the plugin's own rewrites carry no user event, so switching notes can
// never look like "every image was deleted".

const USER_EVENTS = ['input', 'delete', 'move', 'undo', 'redo'];

function idsOnLines(doc: Transaction['state']['doc'], from: number, to: number): Set<string> {
  const start = doc.lineAt(from).from;
  const end = doc.lineAt(to).to;
  return new Set(findDriveLinks(doc.sliceString(start, end)).map((l) => l.fileId));
}

export interface TouchedIds {
  removed: Set<string>;
  added: Set<string>;
}

/** Pure analysis of one transaction. Returns null if it isn't a relevant user edit. */
export function analyzeTransaction(tr: Transaction): TouchedIds | null {
  if (!tr.docChanged) return null;
  if (!USER_EVENTS.some((e) => tr.isUserEvent(e))) return null;

  const removed = new Set<string>();
  const added = new Set<string>();
  const oldDoc = tr.startState.doc;
  const newDoc = tr.state.doc;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    const before = idsOnLines(oldDoc, fromA, toA);
    const after = idsOnLines(newDoc, fromB, toB);
    for (const id of before) if (!after.has(id)) removed.add(id);
    for (const id of after) if (!before.has(id)) added.add(id);
  });

  if (removed.size === 0 && added.size === 0) return null;
  return { removed, added };
}

export function driveDeletionWatcher(
  onTouched: (removed: Set<string>, added: Set<string>) => void,
): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    for (const tr of update.transactions) {
      const touched = analyzeTransaction(tr);
      if (touched) onTouched(touched.removed, touched.added);
    }
  });
}
