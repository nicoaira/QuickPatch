// src/inlineDiffSession.ts
import * as vscode from 'vscode';
import { File, Chunk } from 'parse-diff';
import {
  addedLineDecorationOptions,
  removedLineDecorationOptions,
  skippedHunkDecorationOptions,
  appliedHunkDecorationOptions,
  phantomInsertedLineDecorationType
} from './decorations';

/* ────────────────────────────────────────────────────────── */
/* 1 ▸ PURE HELPERS (fixed so unit-tests pass)                */
/* ────────────────────────────────────────────────────────── */

/** Apply an entire unified diff to a text buffer (all hunks). */
export function applyPatchToContent(originalContent: string, fileDiff: File): string {
  const lines = originalContent.split('\n');
  let out     = [...lines];

  /* work from bottom to top so splice indexes don’t shift */
  for (let i = fileDiff.chunks.length - 1; i >= 0; i--) {
    const chunk = fileDiff.chunks[i];

    const pos         = Math.max(chunk.oldStart - 1, 0);
    const removeCount = chunk.oldLines;
    const insertLines = chunk.changes
      .filter(c => c.type === 'add' || c.type === 'normal') // Corrected filter
      .map(  c => c.content.substring(1));

    out.splice(pos, removeCount, ...insertLines);
  }
  return out.join('\n');
}

/** Apply *only* the selected hunks (by index) to a text buffer. */
export function applySelectedHunksToContent(
  originalContent: string,
  allHunks: Chunk[],
  indices: number[]
): string {
  const lines = originalContent.split('\n');
  let out     = [...lines];

  /* again: process from bottom to top */
  [...indices]
    .sort((a, b) => b - a)
    .forEach(idx => {
      const hunk = allHunks[idx];
      if (!hunk) {return;}

      const pos         = Math.max(hunk.oldStart - 1, 0);
      const removeCount = hunk.oldLines;
      const insertLines = hunk.changes
        .filter(c => c.type === 'add' || c.type === 'normal') // Corrected filter
        .map(  c => c.content.substring(1));

      out.splice(pos, removeCount, ...insertLines);
    });

  return out.join('\n');
}

/* ────────────────────────────────────────────────────────── */
/* 2 ▸ INLINE-DIFF SESSION (unchanged code follows)           */
/* ────────────────────────────────────────────────────────── */

export interface InlineDiffSession {
  uri: vscode.Uri;
  originalFileDiff: File;
  editor: vscode.TextEditor;
  codeLensProvider: DiffHunkCodeLensProvider;
  codeLensDisposable: vscode.Disposable;
  addedDecorationType: vscode.TextEditorDecorationType;
  removedDecorationType: vscode.TextEditorDecorationType;
  skippedHunkDecorationType: vscode.TextEditorDecorationType;
  appliedHunkDecorationType: vscode.TextEditorDecorationType;
  skippedHunkIndices: Set<number>;
  appliedHunkIndices: Set<number>;
  netLineChangesByHunkIndex: Map<number, number>;
  activeHunkIndex: number | null;
}

export let activeInlineDiffSession: InlineDiffSession | undefined;

export async function clearActiveInlineDiffSession() {
  if (!activeInlineDiffSession) {return;}
  const s = activeInlineDiffSession;
  s.editor.setDecorations(s.addedDecorationType, []);
  s.editor.setDecorations(s.removedDecorationType, []);
  s.editor.setDecorations(s.skippedHunkDecorationType, []);
  s.editor.setDecorations(s.appliedHunkDecorationType, []);
  s.editor.setDecorations(phantomInsertedLineDecorationType, []);
  s.codeLensDisposable.dispose();
  s.addedDecorationType.dispose();
  s.removedDecorationType.dispose();
  s.skippedHunkDecorationType.dispose();
  s.appliedHunkDecorationType.dispose();
  activeInlineDiffSession = undefined;
}

/* … everything else in this file stays exactly as before … */


export function getAdjustedStartLineForHunk(hunkIndex: number): number {
  if (!activeInlineDiffSession) {return -1;}
  const { originalFileDiff, netLineChangesByHunkIndex, appliedHunkIndices } = activeInlineDiffSession;
  let offset = 0;
  for (let i = 0; i < hunkIndex; i++) {
    if (appliedHunkIndices.has(i)) {
      offset += netLineChangesByHunkIndex.get(i) || 0;
    }
  }
  return originalFileDiff.chunks[hunkIndex].oldStart - 1 + offset;
}

export function updateDecorations() {
  if (!activeInlineDiffSession) {return;}
  const {
    editor,
    originalFileDiff,
    skippedHunkIndices,
    appliedHunkIndices,
    addedDecorationType,
    removedDecorationType,
    skippedHunkDecorationType,
    appliedHunkDecorationType,
    activeHunkIndex
  } = activeInlineDiffSession;

  const addedDecorations: vscode.Range[] = [];
  const removedDecorations: vscode.Range[] = [];
  const skippedDecorations: vscode.Range[] = [];
  const appliedDecorations: vscode.Range[] = [];
  const phantomDecorations: { range: vscode.Range; renderOptions: any }[] = [];

  originalFileDiff.chunks.forEach((chunk, index) => {
    const isSkipped = skippedHunkIndices.has(index);
    const isApplied = appliedHunkIndices.has(index);
    const startLine = getAdjustedStartLineForHunk(index);
    if (startLine < 0) {return;}

    if (isApplied) {
      for (let i = 0; i < chunk.newLines; i++) {
        const ln = startLine + i;
        if (ln >= 0 && ln < editor.document.lineCount) {
          appliedDecorations.push(editor.document.lineAt(ln).range);
        }
      }
      return;
    }
    if (isSkipped) {
      for (let i = 0; i < chunk.oldLines; i++) {
        const ln = startLine + i;
        if (ln >= 0 && ln < editor.document.lineCount) {
          skippedDecorations.push(editor.document.lineAt(ln).range);
        }
      }
      return;
    }
    if (activeHunkIndex === index) {
      let cursor = startLine;
      let last = startLine;
      chunk.changes.forEach(c => {
        if (c.type === 'normal') {
          last = cursor++;
        } else if (c.type === 'del') {
          if (cursor >= 0 && cursor < editor.document.lineCount) {
            removedDecorations.push(editor.document.lineAt(cursor).range);
          }
          last = cursor++;
        }
      });
      const adds = chunk.changes.filter(c => c.type === 'add').map(c => c.content.substring(1));
      adds.forEach((text, idx) => {
        const ln = Math.min(last + idx + 1, editor.document.lineCount);
        phantomDecorations.push({
          range: new vscode.Range(ln, 0, ln, 0),
          renderOptions: { after: { contentText: text, margin: '0 0 0 0' } }
        });
      });
    }
  });

  editor.setDecorations(addedDecorationType, addedDecorations);
  editor.setDecorations(removedDecorationType, removedDecorations);
  editor.setDecorations(skippedHunkDecorationType, skippedDecorations);
  editor.setDecorations(appliedHunkDecorationType, appliedDecorations);
  editor.setDecorations(phantomInsertedLineDecorationType, phantomDecorations);
}

export async function startInlineDiffReview(
  editor: vscode.TextEditor,
  fileDiff: File,
  targetUri: vscode.Uri
) {
  await clearActiveInlineDiffSession();

  const codeLensProvider = new DiffHunkCodeLensProvider(targetUri, fileDiff);
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    { scheme: 'file', language: editor.document.languageId, pattern: editor.document.fileName },
    codeLensProvider
  );

  activeInlineDiffSession = {
    uri: targetUri,
    originalFileDiff: fileDiff,
    editor,
    codeLensProvider,
    codeLensDisposable,
    addedDecorationType: vscode.window.createTextEditorDecorationType(addedLineDecorationOptions),
    removedDecorationType: vscode.window.createTextEditorDecorationType(removedLineDecorationOptions),
    skippedHunkDecorationType: vscode.window.createTextEditorDecorationType(skippedHunkDecorationOptions),
    appliedHunkDecorationType: vscode.window.createTextEditorDecorationType(appliedHunkDecorationOptions),
    skippedHunkIndices: new Set(),
    appliedHunkIndices: new Set(),
    netLineChangesByHunkIndex: new Map(),
    activeHunkIndex: null
  };

  const first = fileDiff.chunks.findIndex((_, i) =>
    !activeInlineDiffSession!.appliedHunkIndices.has(i) &&
    !activeInlineDiffSession!.skippedHunkIndices.has(i)
  );
  if (first !== -1) {
    await previewHunk(first);
  }
  updateDecorations();
  activeInlineDiffSession.codeLensProvider.refresh();
}

export async function previewHunk(hunkIndex: number) {
  if (!activeInlineDiffSession) {return;}
  activeInlineDiffSession.activeHunkIndex = hunkIndex;
  updateDecorations();
}

export class DiffHunkCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private documentUri: vscode.Uri, private fileDiff: File) {}

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!activeInlineDiffSession || document.uri.toString() !== this.documentUri.toString()) {
      return [];
    }

    const { skippedHunkIndices, appliedHunkIndices } = activeInlineDiffSession;
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);

    lenses.push(new vscode.CodeLens(top, {
      title: "Apply All Remaining Hunks in File",
      command: "quick-diff-apply.applyAllRemainingInFile",
      arguments: [this.documentUri]
    }));
    lenses.push(new vscode.CodeLens(top, {
      title: "Discard All Changes in File",
      command: "quick-diff-apply.discardAllInFile",
      arguments: [this.documentUri]
    }));

    this.fileDiff.chunks.forEach((_, idx) => {
      if (appliedHunkIndices.has(idx) || skippedHunkIndices.has(idx)) {return;}
      const ln = getAdjustedStartLineForHunk(idx);
      if (ln >= 0 && ln < document.lineCount) {
        const range = new vscode.Range(ln, 0, ln, 0);
        lenses.push(new vscode.CodeLens(range, {
          title: "Apply this Hunk",
          command: "quick-diff-apply.applyHunkOnly",
          arguments: [this.documentUri, idx]
        }));
        lenses.push(new vscode.CodeLens(range, {
          title: "Reject this Hunk",
          command: "quick-diff-apply.skipHunk",
          arguments: [this.documentUri, idx]
        }));
      }
    });

    return lenses;
  }
}
