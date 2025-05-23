import * as vscode from 'vscode';

export const addedLineDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
};

export const removedLineDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
};

export const skippedHunkDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('editor.inactiveSelectionBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorHint.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    light:  { gutterIconPath: new vscode.ThemeIcon('debug-step-over').id, gutterIconSize: 'contain' },
    dark:   { gutterIconPath: new vscode.ThemeIcon('debug-step-over').id, gutterIconSize: 'contain' },
};

export const appliedHunkDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('editor.linkedEditingBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorBracketMatch.background'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
};

// <-- this is the *new* “inserted-line” decoration type
export const phantomInsertedLineDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    // we’ll supply the actual text via renderOptions in updateDecorations()
});
