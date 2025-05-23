import * as vscode from 'vscode';
import { File, Chunk } from 'parse-diff';
import { addedLineDecorationOptions, removedLineDecorationOptions, skippedHunkDecorationOptions, appliedHunkDecorationOptions, phantomInsertedLineDecorationType } from './decorations';

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
        activeInlineDiffSession.editor.setDecorations(activeInlineDiffSession.addedDecorationType, []);
        activeInlineDiffSession.editor.setDecorations(activeInlineDiffSession.removedDecorationType, []);
        activeInlineDiffSession.editor.setDecorations(activeInlineDiffSession.skippedHunkDecorationType, []);
        activeInlineDiffSession.editor.setDecorations(activeInlineDiffSession.appliedHunkDecorationType, []);
        activeInlineDiffSession.editor.setDecorations(phantomInsertedLineDecorationType, []);
        activeInlineDiffSession.codeLensDisposable.dispose();
        activeInlineDiffSession.addedDecorationType.dispose();
        activeInlineDiffSession.removedDecorationType.dispose();
        activeInlineDiffSession.skippedHunkDecorationType.dispose();
        activeInlineDiffSession.appliedHunkDecorationType.dispose();
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

    const { editor, originalFileDiff, skippedHunkIndices, appliedHunkIndices, addedDecorationType, removedDecorationType, skippedHunkDecorationType, appliedHunkDecorationType, activeHunkIndex } = activeInlineDiffSession;
    
    const addedDecorations: vscode.Range[] = [];
    const removedDecorations: vscode.Range[] = [];
    const skippedDecorations: vscode.Range[] = [];
    const appliedDecorations: vscode.Range[] = [];
    const phantomDecorations: { range: vscode.Range, renderOptions: any }[] = [];

    originalFileDiff.chunks.forEach((chunk, index) => {
        const isSkipped = skippedHunkIndices.has(index);
        const isApplied = appliedHunkIndices.has(index);
        const adjustedStartLine = getAdjustedStartLineForHunk(index);

        if (adjustedStartLine < 0) return;

        if (isApplied) {
            for (let i = 0; i < chunk.newLines; i++) {
                const lineNum = adjustedStartLine + i;
                if (editor.document.lineCount > lineNum && lineNum >=0) {
                    appliedDecorations.push(editor.document.lineAt(lineNum).range);
                }
            }
            return;
        }
        
        if (isSkipped) {
            for (let i = 0; i < chunk.oldLines; i++) {
                const lineNum = adjustedStartLine + i;
                 if (editor.document.lineCount > lineNum && lineNum >=0) {
                    skippedDecorations.push(editor.document.lineAt(lineNum).range);
                }
            }
            return;
        }

        // Only preview the currently active hunk
        if (activeHunkIndex === index) {
            let lineCursor = adjustedStartLine;
            let lastLineForPhantom = adjustedStartLine;
            chunk.changes.forEach(change => {
                if (change.type === 'normal') {
                    lastLineForPhantom = lineCursor;
                    lineCursor++;
                } else if (change.type === 'del') {
                    if (editor.document.lineCount > lineCursor && lineCursor >= 0) {
                        removedDecorations.push(editor.document.lineAt(lineCursor).range);
                    }
                    lastLineForPhantom = lineCursor;
                    lineCursor++;
                }
            });
            // Show added lines as phantom lines
            let addLines: string[] = chunk.changes.filter(c => c.type === 'add').map(c => c.content.substring(1));
            if (addLines.length > 0) {
                const range = new vscode.Range(lastLineForPhantom, 0, lastLineForPhantom, 0);
                phantomDecorations.push({
                    range,
                    renderOptions: {
                        after: {
                            contentText: addLines.map(l => `+ ${l}`).join('\n'),
                            color: '#22863a',
                            backgroundColor: '#eaffea',
                            margin: '0 0 0 0',
                            fontWeight: 'bold',
                            fontStyle: 'normal',
                            fontSize: '1em',
                        }
                    }
                });
            }
        }
    });
    
    editor.setDecorations(addedDecorationType, addedDecorations);
    editor.setDecorations(removedDecorationType, removedDecorations);
    editor.setDecorations(skippedHunkDecorationType, skippedDecorations);
    editor.setDecorations(appliedHunkDecorationType, appliedDecorations);
    editor.setDecorations(phantomInsertedLineDecorationType, phantomDecorations);
}

export async function startInlineDiffReview(editor: vscode.TextEditor, fileDiff: File, targetUri: vscode.Uri) {
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
        activeHunkIndex: null,
    };
    
    // Find the first unprocessed hunk
    const firstHunkIndex = fileDiff.chunks.findIndex((_, idx) =>
        !activeInlineDiffSession!.appliedHunkIndices.has(idx) && !activeInlineDiffSession!.skippedHunkIndices.has(idx)
    );
    if (firstHunkIndex !== -1) {
        await previewHunk(firstHunkIndex);
    }
    updateDecorations();
    activeInlineDiffSession.codeLensProvider.refresh();
}

// Preview a hunk: show phantom lines and decorate
export async function previewHunk(hunkIndex: number) {
    if (!activeInlineDiffSession) return;
    activeInlineDiffSession.activeHunkIndex = hunkIndex;
    updateDecorations();
}

export class DiffHunkCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor(private documentUri: vscode.Uri, private fileDiff: File) {}

    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        if (!activeInlineDiffSession || document.uri.toString() !== this.documentUri.toString() ) {
            return [];
        }

        const { skippedHunkIndices, appliedHunkIndices } = activeInlineDiffSession;
        const lenses: vscode.CodeLens[] = [];
        const topOfFileRange = new vscode.Range(0, 0, 0, 0);

        lenses.push(new vscode.CodeLens(topOfFileRange, {
            title: "Apply All Remaining Hunks in File",
            command: "quick-diff-apply.applyAllRemainingInFile",
            arguments: [this.documentUri]
        }));
        lenses.push(new vscode.CodeLens(topOfFileRange, {
            title: "Discard All Changes in File",
            command: "quick-diff-apply.discardAllInFile",
            arguments: [this.documentUri]
        }));

        this.fileDiff.chunks.forEach((chunk, index) => {
            if (appliedHunkIndices.has(index) || skippedHunkIndices.has(index)) {
                // Skip further actions for applied or skipped hunks
                return;
            }

            const adjustedStartLine = getAdjustedStartLineForHunk(index);
            if (document.lineCount > adjustedStartLine && adjustedStartLine >=0) {
                const range = new vscode.Range(adjustedStartLine, 0, adjustedStartLine, 0);
                lenses.push(new vscode.CodeLens(range, {
                    title: "Apply this Hunk",
                    command: "quick-diff-apply.applyHunkOnly",
                    arguments: [this.documentUri, index]
                }));
                lenses.push(new vscode.CodeLens(range, {
                    title: "Reject this Hunk",
                    command: "quick-diff-apply.skipHunk",
                    arguments: [this.documentUri, index]
                }));
            }
        });
        return lenses;
    }
}

// Function to apply a specific set of hunks to original content
export function applySelectedHunksToContent(originalContent: string, allHunks: Chunk[], hunksToApplyIndices: number[]): string {
    const lines = originalContent.split('\n');
    let newLines = [...lines];

    // Sort hunks to apply by their original start line in reverse to avoid index shifting issues
    const sortedHunksToApply = hunksToApplyIndices
        .map(index => allHunks[index])
        .filter(hunk => hunk)
        .sort((a, b) => b.oldStart - a.oldStart);

    for (const chunk of sortedHunksToApply) {
        let splicePoint = chunk.oldStart - 1;
        const linesToRemoveCount = chunk.oldLines;
        
        const linesToAddFromChunk = chunk.changes
            .filter(c => c.type === 'add' || c.type === 'normal')
            .map(c => c.content.substring(1));

        newLines.splice(splicePoint, linesToRemoveCount, ...linesToAddFromChunk);
    }
    return newLines.join('\n');
}
