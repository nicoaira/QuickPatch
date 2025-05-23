import * as vscode from 'vscode';
import { File, Chunk } from 'parse-diff';
import {
  addedLineDecorationOptions,
  removedLineDecorationOptions,
  skippedHunkDecorationOptions,
  appliedHunkDecorationOptions,
  phantomInsertedLineDecorationType
} from './decorations';

// --- Inline Diff Review Logic ---
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
  if (activeInlineDiffSession) {
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
}

// Calculates the current starting line in the editor for a hunk, considering previous changes
export function getAdjustedStartLineForHunk(hunkIndex: number): number {
  if (!activeInlineDiffSession) return -1;
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
  if (!activeInlineDiffSession) return;

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
  // NEW: we'll collect our fake-inserted-line decorations here
  const phantomDecorations: { range: vscode.Range; renderOptions: any }[] = [];

  originalFileDiff.chunks.forEach((chunk, index) => {
    const isSkipped = skippedHunkIndices.has(index);
    const isApplied = appliedHunkIndices.has(index);
    const adjustedStartLine = getAdjustedStartLineForHunk(index);
    if (adjustedStartLine < 0) return;

    if (isApplied) {
      // decorate all new lines with the subtle “applied” style
      for (let i = 0; i < chunk.newLines; i++) {
        const ln = adjustedStartLine + i;
        if (ln >= 0 && ln < editor.document.lineCount) {
          appliedDecorations.push(editor.document.lineAt(ln).range);
        }
      }
      return;
    }

    if (isSkipped) {
      // decorate all old lines with the “skipped” style
      for (let i = 0; i < chunk.oldLines; i++) {
        const ln = adjustedStartLine + i;
        if (ln >= 0 && ln < editor.document.lineCount) {
          skippedDecorations.push(editor.document.lineAt(ln).range);
        }
      }
      return;
    }

    if (activeHunkIndex === index) {
      // highlight deleted/context lines
      let lineCursor = adjustedStartLine;
      let lastLineForInsert = adjustedStartLine;

      chunk.changes.forEach(change => {
        if (change.type === 'normal') {
          lastLineForInsert = lineCursor;
          lineCursor++;
        } else if (change.type === 'del') {
          if (lineCursor >= 0 && lineCursor < editor.document.lineCount) {
            removedDecorations.push(editor.document.lineAt(lineCursor).range);
          }
          lastLineForInsert = lineCursor;
          lineCursor++;
        }
      });

      // now for each added line, insert a fake line *below* the last deleted/context line
      const addLines = chunk.changes
        .filter(c => c.type === 'add')
        .map(c => c.content.substring(1));
      addLines.forEach((text, idx) => {
        // place each inserted line one after another
        const fakeLine = lastLineForInsert + idx + 1;
        // if fakeLine > doc lineCount, use doc lineCount so decoration still shows
        const ln = Math.min(fakeLine, editor.document.lineCount);
        const range = new vscode.Range(ln, 0, ln, 0);
        phantomDecorations.push({
          range,
          renderOptions: {
            after: {
              contentText: text,
              margin: '0 0 0 0'
            }
          }
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
    skippedHunkIndices: new Set<number>(),
    appliedHunkIndices: new Set<number>(),
    netLineChangesByHunkIndex: new Map<number, number>(),
    activeHunkIndex: null
  };

  // preview first hunk
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
  if (!activeInlineDiffSession) return;
  activeInlineDiffSession.activeHunkIndex = hunkIndex;
  updateDecorations();
}

export class DiffHunkCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private documentUri: vscode.Uri, private fileDiff: File) {}

  refresh() {
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
      if (appliedHunkIndices.has(idx) || skippedHunkIndices.has(idx)) return;
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

// end of inlineDiffSession.ts
