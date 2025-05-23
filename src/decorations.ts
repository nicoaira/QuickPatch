import * as vscode from 'vscode';

export const addedLineDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    light: { after: { contentText: '+', color: new vscode.ThemeColor('diffEditor.insertedTextBackground') } },
    dark: { after: { contentText: '+', color: new vscode.ThemeColor('diffEditor.insertedTextBackground') } },
};

export const removedLineDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    light: { after: { contentText: '-', color: new vscode.ThemeColor('diffEditor.removedTextBackground') } },
    dark: { after: { contentText: '-', color: new vscode.ThemeColor('diffEditor.removedTextBackground') } },
};

export const skippedHunkDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('editor.inactiveSelectionBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorHint.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    light: { gutterIconPath: new vscode.ThemeIcon('debug-step-over').id, gutterIconSize: 'contain' },
    dark: { gutterIconPath: new vscode.ThemeIcon('debug-step-over').id, gutterIconSize: 'contain' },
};

export const appliedHunkDecorationOptions: vscode.DecorationRenderOptions = {
    backgroundColor: new vscode.ThemeColor('editor.linkedEditingBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorBracketMatch.background'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
};

export const phantomInsertedLineDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        color: '#1eeb1e',
        backgroundColor: '#eaffea',
        margin: '0 0 0 20px',
        fontStyle: 'italic',
    },
    isWholeLine: false,
});
