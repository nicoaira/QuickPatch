// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import parseDiff, { File, Chunk, Change } from 'parse-diff'; // Corrected import, added Chunk and Change
import * as nodeFs from 'node:fs'; // Renamed to avoid conflict with vscode.fs
import * as nodePath from 'node:path'; // Renamed to avoid conflict
import * as os from 'node:os'; // Explicitly use node:os

// --- Decoration Options ---
const addedLineDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    light: { after: { contentText: '+', color: new vscode.ThemeColor('diffEditor.insertedTextBackground') } },
    dark: { after: { contentText: '+', color: new vscode.ThemeColor('diffEditor.insertedTextBackground') } },
};

const removedLineDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    light: { after: { contentText: '-', color: new vscode.ThemeColor('diffEditor.removedTextBackground') } },
    dark: { after: { contentText: '-', color: new vscode.ThemeColor('diffEditor.removedTextBackground') } },
};

const skippedHunkDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('editor.inactiveSelectionBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorHint.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    light: { gutterIconPath: new vscode.ThemeIcon('debug-step-over').id, gutterIconSize: 'contain' }, // Example, adjust as needed
    dark: { gutterIconPath: new vscode.ThemeIcon('debug-step-over').id, gutterIconSize: 'contain' },
};

const appliedHunkDecorationOptions: vscode.DecorationRenderOptions = {
    // Example: subtle indication, or could be no decoration
    // For now, let's make it very subtle or effectively clear the other decorations
    // Or a specific color like a faint green or grey
    backgroundColor: new vscode.ThemeColor('editor.linkedEditingBackground'), // A very subtle background
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorBracketMatch.background'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
};

// Helper function to apply patch to content (can be extracted or remain inline)
function applyPatchToContent(originalContent: string, fileDiff: File): string {
    const lines = originalContent.split('\n');
    let newLines = [...lines];

    // Apply chunks in reverse to avoid line number shifts
    for (let i = fileDiff.chunks.length - 1; i >= 0; i--) {
        const chunk = fileDiff.chunks[i];
        let currentPositionInNewLines = chunk.newStart - 1; // 0-indexed

        // Ensure currentPositionInNewLines is not negative, especially for new files or empty files
        if (currentPositionInNewLines < 0) currentPositionInNewLines = 0;

        const linesToRemove = chunk.changes.filter((c: Change) => c.type === 'del' || c.type === 'normal').length;
        const linesToAdd = chunk.changes
            .filter((c: Change) => c.type === 'add' || c.type === 'normal')
            .map((c: Change) => c.content.substring(1));
        
        newLines.splice(currentPositionInNewLines, linesToRemove, ...linesToAdd);
    }
    return newLines.join('\n');
}

function getNewFileContentFromDiff(fileDiff: File): string {
    let newFileContent = '';
    for (const chunk of fileDiff.chunks) {
        for (const change of chunk.changes) {
            if (change.type === 'add') {
                newFileContent += change.content.substring(1) + '\n';
            }
        }
    }
    // Remove trailing newline if present, as it might be added by the loop
    if (newFileContent.endsWith('\n')) {
        newFileContent = newFileContent.slice(0, -1);
    }
    return newFileContent;
}

// --- Inline Diff Review Logic ---
interface InlineDiffSession {
    uri: vscode.Uri;
    originalFileDiff: File; // Store the complete original diff
    editor: vscode.TextEditor;
    codeLensProvider: DiffHunkCodeLensProvider; // Store provider instance
    codeLensDisposable: vscode.Disposable;
    addedDecorationType: vscode.TextEditorDecorationType;
    removedDecorationType: vscode.TextEditorDecorationType;
    skippedHunkDecorationType: vscode.TextEditorDecorationType; // New
    appliedHunkDecorationType: vscode.TextEditorDecorationType; // New decoration for applied hunks
    skippedHunkIndices: Set<number>; // Tracks indices of skipped hunks
    appliedHunkIndices: Set<number>; // New: Tracks indices of applied hunks
    // Stores the net line change (newLines - oldLines) for each hunk *once applied*
    // Key: original hunk index, Value: net line change
    netLineChangesByHunkIndex: Map<number, number>; 
}
let activeInlineDiffSession: InlineDiffSession | undefined;

function clearActiveInlineDiffSession() {
    if (activeInlineDiffSession) {
        activeInlineDiffSession.editor.setDecorations(activeInlineDiffSession.addedDecorationType, []);
        activeInlineDiffSession.editor.setDecorations(activeInlineDiffSession.removedDecorationType, []);
        activeInlineDiffSession.editor.setDecorations(activeInlineDiffSession.skippedHunkDecorationType, []);
        activeInlineDiffSession.editor.setDecorations(activeInlineDiffSession.appliedHunkDecorationType, []); // Clear applied
        activeInlineDiffSession.codeLensDisposable.dispose();
        activeInlineDiffSession.addedDecorationType.dispose();
        activeInlineDiffSession.removedDecorationType.dispose();
        activeInlineDiffSession.skippedHunkDecorationType.dispose();
        activeInlineDiffSession.appliedHunkDecorationType.dispose(); // Dispose new decoration
        activeInlineDiffSession = undefined;
    }
}

// Calculates the current starting line in the editor for a hunk, considering previous changes
function getAdjustedStartLineForHunk(hunkIndex: number): number {
    if (!activeInlineDiffSession) return -1;
    const { originalFileDiff, netLineChangesByHunkIndex, appliedHunkIndices } = activeInlineDiffSession;
    let offset = 0;
    for (let i = 0; i < hunkIndex; i++) {
        if (appliedHunkIndices.has(i)) { // Only consider *applied* hunks for offset
            offset += netLineChangesByHunkIndex.get(i) || 0;
        }
    }
    return originalFileDiff.chunks[hunkIndex].oldStart - 1 + offset;
}

function updateDecorations() {
    if (!activeInlineDiffSession) return;

    const { editor, originalFileDiff, skippedHunkIndices, appliedHunkIndices, addedDecorationType, removedDecorationType, skippedHunkDecorationType, appliedHunkDecorationType } = activeInlineDiffSession;
    
    const addedDecorations: vscode.Range[] = [];
    const removedDecorations: vscode.Range[] = [];
    const skippedDecorations: vscode.Range[] = [];
    const appliedDecorations: vscode.Range[] = []; // For hunks that have been applied

    originalFileDiff.chunks.forEach((chunk, index) => {
        const isSkipped = skippedHunkIndices.has(index);
        const isApplied = appliedHunkIndices.has(index);
        const adjustedStartLine = getAdjustedStartLineForHunk(index);

        if (adjustedStartLine < 0) return; // Should not happen if session is active

        let currentLineInChunkContent = adjustedStartLine; // Tracks line numbers within the current state of the document for this hunk

        if (isApplied) {
            // Decorate all lines that were part of this hunk's *new* content
            for (let i = 0; i < chunk.newLines; i++) {
                const lineNum = adjustedStartLine + i;
                if (editor.document.lineCount > lineNum && lineNum >=0) {
                    appliedDecorations.push(editor.document.lineAt(lineNum).range);
                }
            }
            return; // Don't process further for applied hunks
        }
        
        if (isSkipped) {
            // Decorate all lines that were part of this hunk's *original* footprint
            for (let i = 0; i < chunk.oldLines; i++) {
                const lineNum = adjustedStartLine + i;
                 if (editor.document.lineCount > lineNum && lineNum >=0) {
                    skippedDecorations.push(editor.document.lineAt(lineNum).range);
                }
            }
            return; // Don't process further for skipped hunks
        }

        // Normal processing for active (not skipped, not applied) hunks
        let lineCursorInOriginal = adjustedStartLine;
        chunk.changes.forEach(change => {
            if (change.type === 'normal') {
                if (editor.document.lineCount > lineCursorInOriginal && lineCursorInOriginal >=0) {
                    // No specific decoration for normal lines within an active hunk, or could be subtle
                }
                lineCursorInOriginal++;
            } else if (change.type === 'add') {
                // For 'add', the decoration is typically on the line *before* or where it's inserted.
                // This is tricky as the line doesn't exist yet.
                // We'll mark the line it's conceptually added *after* or at.
                const lineForAddMarker = Math.max(0, lineCursorInOriginal -1); 
                 if (editor.document.lineCount > lineForAddMarker && lineForAddMarker >=0) {
                     addedDecorations.push(editor.document.lineAt(lineForAddMarker).range); // Mark line before
                }
                // Additions don't consume lines from the original for decoration purposes here
            } else if (change.type === 'del') {
                 if (editor.document.lineCount > lineCursorInOriginal && lineCursorInOriginal >=0) {
                    removedDecorations.push(editor.document.lineAt(lineCursorInOriginal).range);
                }
                lineCursorInOriginal++;
            }
        });
    });
    
    editor.setDecorations(addedDecorationType, addedDecorations);
    editor.setDecorations(removedDecorationType, removedDecorations);
    editor.setDecorations(skippedHunkDecorationType, skippedDecorations);
    editor.setDecorations(appliedHunkDecorationType, appliedDecorations); // Set applied decorations
}

async function startInlineDiffReview(editor: vscode.TextEditor, fileDiff: File, targetUri: vscode.Uri) {
    clearActiveInlineDiffSession(); 

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
        appliedHunkDecorationType: vscode.window.createTextEditorDecorationType(appliedHunkDecorationOptions), // Init new decoration
        skippedHunkIndices: new Set<number>(),
        appliedHunkIndices: new Set<number>(), // Initialize applied set
        netLineChangesByHunkIndex: new Map<number, number>(), // Initialize map
    };
    updateDecorations(); 
    activeInlineDiffSession.codeLensProvider.refresh(); 
}

class DiffHunkCodeLensProvider implements vscode.CodeLensProvider {
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
            if (appliedHunkIndices.has(index)) {
                // Optionally, show an "Applied" CodeLens or no CodeLens
                const adjustedStartLine = getAdjustedStartLineForHunk(index);
                if (document.lineCount > adjustedStartLine && adjustedStartLine >=0) {
                    const range = new vscode.Range(adjustedStartLine, 0, adjustedStartLine, 0);
                    // lenses.push(new vscode.CodeLens(range, { title: "✓ Applied", command: "" })); // Example
                }
                return; // Skip further actions for applied hunks
            }
            if (skippedHunkIndices.has(index)) {
                 const adjustedStartLine = getAdjustedStartLineForHunk(index);
                 if (document.lineCount > adjustedStartLine && adjustedStartLine >=0) {
                    const range = new vscode.Range(adjustedStartLine, 0, adjustedStartLine, 0);
                    // lenses.push(new vscode.CodeLens(range, { title: "✗ Rejected", command: "" })); // Example
                }
                return; // Skip further actions for rejected hunks
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
function applySelectedHunksToContent(originalContent: string, allHunks: Chunk[], hunksToApplyIndices: number[]): string {
    const lines = originalContent.split('\n');
    let newLines = [...lines];

    // Sort hunks to apply by their original start line in reverse to avoid index shifting issues
    const sortedHunksToApply = hunksToApplyIndices
        .map(index => allHunks[index])
        .filter(hunk => hunk) // Ensure hunk exists
        .sort((a, b) => b.oldStart - a.oldStart);

    for (const chunk of sortedHunksToApply) {
        let currentPositionInNewLines = chunk.newStart - 1;
        if (currentPositionInNewLines < 0) currentPositionInNewLines = 0;
        
        // This logic is from applyPatchToContent, needs to be adapted if newStart is relative to original
        // For applying hunks to an original string, oldStart and oldLines are key for removal,
        // and then new lines are inserted.
        // The splice point should be based on oldStart for the original content.
        let splicePoint = chunk.oldStart -1;
        const linesToRemoveCount = chunk.oldLines;
        
        const linesToAddFromChunk = chunk.changes
            .filter(c => c.type === 'add' || c.type === 'normal')
            .map(c => c.content.substring(1));

        newLines.splice(splicePoint, linesToRemoveCount, ...linesToAddFromChunk);
    }
    return newLines.join('\n');
}
// --- End Inline Diff Review Logic ---

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "quick-diff-apply" is now active!');

    // Register new commands
    const applyHunkOnlyCommand = vscode.commands.registerCommand('quick-diff-apply.applyHunkOnly', async (fileUri: vscode.Uri, hunkIndex: number) => {
        if (!activeInlineDiffSession || activeInlineDiffSession.uri.toString() !== fileUri.toString()) return;
        // Ensure skippedHunkIndices is destructured here
        const { originalFileDiff, editor, netLineChangesByHunkIndex, appliedHunkIndices, skippedHunkIndices } = activeInlineDiffSession;
        if (appliedHunkIndices.has(hunkIndex) || skippedHunkIndices.has(hunkIndex)) return;

        const hunk = originalFileDiff.chunks[hunkIndex];
        if (!hunk) {
            vscode.window.showErrorMessage("Invalid hunk index.");
            // Don't clear session here, allow user to continue if possible or discard
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const adjustedStartLine = getAdjustedStartLineForHunk(hunkIndex);
        
        // Ensure valid range
        if (adjustedStartLine < 0 || (hunk.oldLines > 0 && adjustedStartLine + hunk.oldLines > editor.document.lineCount)) {
             // If hunk.oldLines is 0 (pure addition), adjustedStartLine can be editor.document.lineCount
            if (!(hunk.oldLines === 0 && adjustedStartLine <= editor.document.lineCount)) {
                vscode.window.showErrorMessage(`Cannot apply hunk: Invalid line numbers for removal in editor. Adjusted Start: ${adjustedStartLine}, Hunk Old Lines: ${hunk.oldLines}, Total doc lines: ${editor.document.lineCount}`);
                return; // Don't clear session, let user try something else or discard
            }
        }
        
        const rangeToRemove = new vscode.Range(
            new vscode.Position(adjustedStartLine, 0),
            // If hunk.oldLines is 0, it's a pure addition, so end position is same as start.
            // Otherwise, it's adjustedStartLine + hunk.oldLines
            new vscode.Position(hunk.oldLines > 0 ? adjustedStartLine + hunk.oldLines : adjustedStartLine, 0)
        );
        // Correction for end of range: it should be the line *before* the next one, or end of last line.
        // So, if oldLines is 1, range is (adjustedStartLine, 0) to (adjustedStartLine + 1, 0) effectively removing 1 line.
        // Or, (adjustedStartLine, 0) to (adjustedStartLine, length of line) for single line removal.
        // Let's use a simpler model: replace from start of first line to remove, to start of line *after* last line to remove.
        
        let endLineOfRemoval: number;
        let endCharOfRemoval = 0;

        if (hunk.oldLines === 0) { // Pure addition
            endLineOfRemoval = adjustedStartLine;
        } else {
            endLineOfRemoval = adjustedStartLine + hunk.oldLines;
        }
        // Ensure endLineOfRemoval does not exceed document lines. If it does, it means we are removing till the end.
        if (endLineOfRemoval > editor.document.lineCount) {
            endLineOfRemoval = editor.document.lineCount;
            if (editor.document.lineCount > 0) {
                 endCharOfRemoval = editor.document.lineAt(editor.document.lineCount -1).range.end.character;
            }
        } else if (endLineOfRemoval < editor.document.lineCount && hunk.oldLines > 0) {
             // If not removing till the end, the range ends at the start of the next line
             endCharOfRemoval = 0;
        } else if (hunk.oldLines > 0 && endLineOfRemoval > 0) { // Removing lines and endLineOfRemoval is a valid line index
            endCharOfRemoval = editor.document.lineAt(endLineOfRemoval -1).range.end.character;
        }


        const preciseRangeToRemove = new vscode.Range(
            new vscode.Position(adjustedStartLine, 0),
            new vscode.Position(endLineOfRemoval, endCharOfRemoval) 
            // This might still be tricky. The vscode.Range for N lines is (startLine, 0) to (startLine + N, 0)
            // Or (startLine, 0) to (startLine + N-1, length_of_last_line_to_remove)
        );
         const finalRangeToRemove = new vscode.Range(
            new vscode.Position(adjustedStartLine, 0),
            new vscode.Position(adjustedStartLine + hunk.oldLines, 0)
        );


        let newTextForHunk = "";
        hunk.changes.forEach(change => {
            if (change.type === 'add' || change.type === 'normal') {
                newTextForHunk += change.content.substring(1) + '\n';
            }
        });
        if (hunk.newLines === 0 && newTextForHunk === "\n") { // Pure deletion resulting in empty newText
            newTextForHunk = "";
        }


        edit.replace(fileUri, finalRangeToRemove, newTextForHunk);
        
        try {
            const oldLineCount = editor.document.lineCount; // Capture line count before edit
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                const newLineCount = editor.document.lineCount; // Capture line count after edit
                const actualLineDelta = newLineCount - oldLineCount; // Calculate actual delta

                vscode.window.showInformationMessage(`Hunk ${hunkIndex + 1} applied.`);
                appliedHunkIndices.add(hunkIndex);
                netLineChangesByHunkIndex.set(hunkIndex, actualLineDelta); // Use actual delta
                
                updateDecorations();
                activeInlineDiffSession.codeLensProvider.refresh();

                // Check if all hunks are processed
                const allHunksProcessed = originalFileDiff.chunks.every((_, idx) => appliedHunkIndices.has(idx) || skippedHunkIndices.has(idx));
                if (allHunksProcessed) {
                    vscode.window.showInformationMessage("All hunks processed.");
                    clearActiveInlineDiffSession();
                }

            } else {
                vscode.window.showErrorMessage(`Failed to apply hunk ${hunkIndex + 1}. The editor might be in an inconsistent state.`);
                // Optionally clear session here as applying failed.
                // clearActiveInlineDiffSession(); 
            }
        } catch (e: any) { 
            vscode.window.showErrorMessage(`Error applying hunk: ${e.message}`);
            // clearActiveInlineDiffSession(); 
        }
        // DO NOT clearActiveInlineDiffSession() here by default, to allow continuation.
        // It's cleared if all hunks are processed or if "Discard All" etc. is chosen.
    });

    const skipHunkCommand = vscode.commands.registerCommand('quick-diff-apply.skipHunk', async (fileUri: vscode.Uri, hunkIndex: number) => {
        if (!activeInlineDiffSession || activeInlineDiffSession.uri.toString() !== fileUri.toString()) return;
        if (activeInlineDiffSession.appliedHunkIndices.has(hunkIndex)) return; // Cannot skip already applied

        activeInlineDiffSession.skippedHunkIndices.add(hunkIndex);
        updateDecorations();
        activeInlineDiffSession.codeLensProvider.refresh();

        const { originalFileDiff, appliedHunkIndices, skippedHunkIndices } = activeInlineDiffSession;
        const allHunksProcessed = originalFileDiff.chunks.every((_, idx) => appliedHunkIndices.has(idx) || skippedHunkIndices.has(idx));
        if (allHunksProcessed) {
            vscode.window.showInformationMessage("All hunks processed.");
            clearActiveInlineDiffSession();
        }
    });

    const applyAllRemainingCommand = vscode.commands.registerCommand('quick-diff-apply.applyAllRemainingInFile', async (fileUri: vscode.Uri) => {
        if (!activeInlineDiffSession || activeInlineDiffSession.uri.toString() !== fileUri.toString()) return;

        const { originalFileDiff, editor, skippedHunkIndices, appliedHunkIndices, netLineChangesByHunkIndex } = activeInlineDiffSession;
        
        // Process hunks in order
        for (let i = 0; i < originalFileDiff.chunks.length; i++) {
            if (appliedHunkIndices.has(i) || skippedHunkIndices.has(i)) {
                continue; // Already processed or skipped
            }

            const hunk = originalFileDiff.chunks[i];
            const edit = new vscode.WorkspaceEdit();
            const adjustedStartLine = getAdjustedStartLineForHunk(i); // Get current start line

            const rangeToRemove = new vscode.Range(
                new vscode.Position(adjustedStartLine, 0),
                new vscode.Position(adjustedStartLine + hunk.oldLines, 0)
            );
            let newTextForHunk = "";
            hunk.changes.forEach(change => {
                if (change.type === 'add' || change.type === 'normal') {
                    newTextForHunk += change.content.substring(1) + '\n';
                }
            });
            if (hunk.newLines === 0 && newTextForHunk === "\n") {
                newTextForHunk = "";
            }
            
            edit.replace(fileUri, rangeToRemove, newTextForHunk);

            try {
                const oldLineCount = editor.document.lineCount; // Capture line count before edit
                const success = await vscode.workspace.applyEdit(edit);
                if (success) {
                    const newLineCount = editor.document.lineCount; // Capture line count after edit
                    const actualLineDelta = newLineCount - oldLineCount; // Calculate actual delta

                    appliedHunkIndices.add(i);
                    netLineChangesByHunkIndex.set(i, actualLineDelta); // Use actual delta
                } else {
                    vscode.window.showErrorMessage(`Failed to apply hunk ${i + 1} during 'Apply All'.`);
                    updateDecorations(); // Update to show current state
                    activeInlineDiffSession.codeLensProvider.refresh();
                    return; 
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Error applying hunk ${i + 1} during 'Apply All': ${e.message}`);
                updateDecorations();
                activeInlineDiffSession.codeLensProvider.refresh();
                return;
            }
        }
        
        vscode.window.showInformationMessage("All remaining hunks applied.");
        clearActiveInlineDiffSession(); // All successfully processed or skipped
    });

    const discardAllCommand = vscode.commands.registerCommand('quick-diff-apply.discardAllInFile', async (fileUri: vscode.Uri) => {
        if (!activeInlineDiffSession || activeInlineDiffSession.uri.toString() !== fileUri.toString()) return;
        clearActiveInlineDiffSession();
        vscode.window.showInformationMessage("Changes discarded for this file.");
    });
    
    context.subscriptions.push(applyHunkOnlyCommand, skipHunkCommand, applyAllRemainingCommand, discardAllCommand);

    // ... (rest of the activate function, including the main applyDiffCommand)
    // The main applyDiffCommand needs to be here, slightly modified from previous step
    const applyDiffCommand = vscode.commands.registerCommand('quick-diff-apply.applyDiff', async (contextUri?: vscode.Uri) => {
        let tempDir: string | undefined;
        if (activeInlineDiffSession && (!contextUri || activeInlineDiffSession.uri.toString() !== contextUri.toString())) {
            clearActiveInlineDiffSession();
        }

        try {
            const diffText = await vscode.env.clipboard.readText();
            if (!diffText) {
                vscode.window.showWarningMessage('Clipboard is empty.'); return;
            }
            const parsedFiles: File[] = parseDiff(diffText);
            if (parsedFiles.length === 0) {
                vscode.window.showWarningMessage('No diff information found.'); return;
            }
            const workspaceRootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!workspaceRootUri) {
                vscode.window.showErrorMessage('No workspace folder open.'); return;
            }

            if (parsedFiles.length === 1) {
                const fileDiff = parsedFiles[0];
                const targetPath = fileDiff.to || fileDiff.from;
                if (targetPath && targetPath !== '/dev/null' && !fileDiff.new && !fileDiff.deleted && fileDiff.from === fileDiff.to) {
                    const targetUri = vscode.Uri.joinPath(workspaceRootUri, targetPath);
                    try {
                        await vscode.workspace.fs.stat(targetUri);
                        const editor = await vscode.window.showTextDocument(targetUri, { preview: false });
                        await startInlineDiffReview(editor, fileDiff, targetUri);
                        return; 
                    } catch (e) {
                        vscode.window.showWarningMessage(`File ${targetPath} not found for inline review. Falling back to diff preview.`);
                    }
                }
            }
            
            // --- FALLBACK TO vscode.diff PREVIEW (existing logic from previous step) ---
            tempDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'vscode-quick-diff-apply-'));
            const previewsToShow: Array<{ originalUri: vscode.Uri, patchedUri: vscode.Uri, displayName: string, file: File }> = [];

            for (const file of parsedFiles) {
                const targetPath = file.to || file.from;
                if (!targetPath || (targetPath === '/dev/null' && !file.from && !file.to) ) continue; 

                let originalUriForDiff: vscode.Uri;
                let patchedUriForDiff: vscode.Uri;
                let displayName = nodePath.basename(targetPath === '/dev/null' ? (file.from || 'unknown') : targetPath);
                
                const tempOriginalFilePath = nodePath.join(tempDir, `original-${Date.now()}-${displayName}`);
                const tempPatchedFilePath = nodePath.join(tempDir, `patched-${Date.now()}-${displayName}`);

                if (file.new || file.from === '/dev/null') {
                    displayName = nodePath.basename(file.to || 'new-file');
                    const newContent = getNewFileContentFromDiff(file);
                    nodeFs.writeFileSync(tempOriginalFilePath, ''); 
                    nodeFs.writeFileSync(tempPatchedFilePath, newContent);
                    originalUriForDiff = vscode.Uri.file(tempOriginalFilePath);
                    patchedUriForDiff = vscode.Uri.file(tempPatchedFilePath);
                } else if (file.deleted || file.to === '/dev/null') {
                    displayName = nodePath.basename(file.from || 'deleted-file');
                    const actualFileUri = vscode.Uri.joinPath(workspaceRootUri, file.from!);
                    try {
                        const originalContent = Buffer.from(await vscode.workspace.fs.readFile(actualFileUri)).toString('utf8');
                        nodeFs.writeFileSync(tempOriginalFilePath, originalContent);
                        originalUriForDiff = vscode.Uri.file(tempOriginalFilePath);
                    } catch (e) {
                        nodeFs.writeFileSync(tempOriginalFilePath, '');
                        originalUriForDiff = vscode.Uri.file(tempOriginalFilePath);
                    }
                    nodeFs.writeFileSync(tempPatchedFilePath, '');
                    patchedUriForDiff = vscode.Uri.file(tempPatchedFilePath);
                } else { 
                    displayName = nodePath.basename(file.to || file.from || 'modified-file');
                    const actualFileUri = vscode.Uri.joinPath(workspaceRootUri, file.to || file.from!);
                    let originalContent = '';
                    try {
                        originalContent = Buffer.from(await vscode.workspace.fs.readFile(actualFileUri)).toString('utf8');
                    } catch (e) {
                        vscode.window.showWarningMessage(`File not found, cannot apply patch or show diff: ${file.to || file.from}`);
                        continue;
                    }
                    const patchedContentFull = applyPatchToContent(originalContent, file); // Use the original applyPatchToContent for full file
                    originalUriForDiff = actualFileUri; 
                    nodeFs.writeFileSync(tempPatchedFilePath, patchedContentFull);
                    patchedUriForDiff = vscode.Uri.file(tempPatchedFilePath);
                }
                previewsToShow.push({ originalUri: originalUriForDiff, patchedUri: patchedUriForDiff, displayName, file });
            }

            if (previewsToShow.length === 0) {
                vscode.window.showInformationMessage('No changes to preview or apply.');
                if (tempDir) nodeFs.rmSync(tempDir, { recursive: true, force: true });
                return;
            }

            for (const preview of previewsToShow) {
                await vscode.commands.executeCommand('vscode.diff', preview.originalUri, preview.patchedUri, `Preview: ${preview.displayName}`);
            }

            const confirmation = await vscode.window.showInformationMessage(
                `You have reviewed ${previewsToShow.length} file(s). Apply these changes to your workspace?`,
                { modal: true },
                'Apply All Changes', 'Discard All'
            );

            if (confirmation === 'Apply All Changes') {
                const workspaceEdit = new vscode.WorkspaceEdit();
                let changesAppliedCount = 0;
                // ... (rest of the logic for applying changes from vscode.diff preview)
                // This part is largely the same as your previous working version for multi-file.
                for (const preview of previewsToShow) {
                    const fileDiff = preview.file;
                    const filePathInDiff = fileDiff.to || fileDiff.from;
                    // Handle /dev/null for new/deleted files correctly for targetUriInWorkspace
                    let targetUriInWorkspace: vscode.Uri;
                     if (fileDiff.new && fileDiff.to && fileDiff.to !== '/dev/null') {
                        targetUriInWorkspace = vscode.Uri.joinPath(workspaceRootUri, fileDiff.to);
                    } else if (fileDiff.deleted && fileDiff.from && fileDiff.from !== '/dev/null') {
                        targetUriInWorkspace = vscode.Uri.joinPath(workspaceRootUri, fileDiff.from);
                    } else if (filePathInDiff && filePathInDiff !== '/dev/null') {
                        targetUriInWorkspace = vscode.Uri.joinPath(workspaceRootUri, filePathInDiff);
                    } else {
                        continue; // Should not happen if previewsToShow was populated correctly
                    }

                    try {
                        if (fileDiff.new || fileDiff.from === '/dev/null') {
                            const newContent = getNewFileContentFromDiff(fileDiff);
                             try { // Check if file exists before deciding to replace or create
                                await vscode.workspace.fs.stat(targetUriInWorkspace);
                                const existingContentBuffer = await vscode.workspace.fs.readFile(targetUriInWorkspace);
                                const existingContentLines = Buffer.from(existingContentBuffer).toString('utf8').split('\n');
                                const fullRange = new vscode.Range(new vscode.Position(0,0), new vscode.Position(existingContentLines.length, existingContentLines[existingContentLines.length-1]?.length || 0));
                                workspaceEdit.replace(targetUriInWorkspace, fullRange, newContent);
                            } catch (e) { // File does not exist, create it
                                workspaceEdit.createFile(targetUriInWorkspace, { ignoreIfExists: false, contents: Buffer.from(newContent) });
                            }
                            changesAppliedCount++;
                        } else if (fileDiff.deleted || fileDiff.to === '/dev/null') {
                            workspaceEdit.deleteFile(targetUriInWorkspace, { ignoreIfNotExists: true });
                            changesAppliedCount++;
                        } else { 
                            const originalFileContent = Buffer.from(await vscode.workspace.fs.readFile(targetUriInWorkspace)).toString('utf8');
                            const patchedContent = applyPatchToContent(originalFileContent, fileDiff); // Use full patch for this path
                            const originalLines = originalFileContent.split('\n');
                            const fullRange = new vscode.Range(
                                new vscode.Position(0, 0),
                                new vscode.Position(originalLines.length, originalLines[originalLines.length - 1]?.length || 0)
                            );
                            workspaceEdit.replace(targetUriInWorkspace, fullRange, patchedContent);
                            changesAppliedCount++;
                        }
                    } catch (error: any) {
                        console.error(`Error preparing edit for ${filePathInDiff}:`, error);
                        vscode.window.showErrorMessage(`Failed to prepare changes for ${filePathInDiff}: ${error.message}`);
                    }
                }
                 if (changesAppliedCount > 0) {
                    await vscode.workspace.applyEdit(workspaceEdit);
                    vscode.window.showInformationMessage(`Diff applied successfully to ${changesAppliedCount} file(s).`);
                } else {
                    vscode.window.showInformationMessage('No changes were applied from the diff.');
                }
            }
             // --- END FALLBACK ---
        } catch (error: any) {
            console.error('Error applying diff:', error);
            vscode.window.showErrorMessage(`Failed to apply diff: ${error.message}`);
        } finally {
            if (tempDir) {
                try { nodeFs.rmSync(tempDir, { recursive: true, force: true }); }
                catch (e) { console.error('Failed to clean up temp dir:', tempDir, e); }
            }
        }
    });
    context.subscriptions.push(applyDiffCommand);

    // Remove or repurpose the helloWorld command if not needed
    const helloWorldCommand = vscode.commands.registerCommand('quick-diff-apply.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from Quick Diff Apply is still here!');
    });
    context.subscriptions.push(helloWorldCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {
    clearActiveInlineDiffSession(); // Ensure cleanup on deactivation
}
