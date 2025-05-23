import * as vscode from 'vscode';
import parseDiff, { File } from 'parse-diff';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { applyPatchToContent, getNewFileContentFromDiff } from './patchUtils';
import { 
    activeInlineDiffSession, 
    clearActiveInlineDiffSession, 
    getAdjustedStartLineForHunk, 
    updateDecorations, 
    startInlineDiffReview, 
    previewHunk
} from './inlineDiffSession';

export function registerApplyHunkOnlyCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('quick-diff-apply.applyHunkOnly', async (fileUri: vscode.Uri, hunkIndex: number) => {
        if (!activeInlineDiffSession || activeInlineDiffSession.uri.toString() !== fileUri.toString()) return;
        
        const { originalFileDiff, editor, netLineChangesByHunkIndex, appliedHunkIndices, skippedHunkIndices } = activeInlineDiffSession;
        if (appliedHunkIndices.has(hunkIndex) || skippedHunkIndices.has(hunkIndex)) return;

        const hunk = originalFileDiff.chunks[hunkIndex];
        if (!hunk) {
            vscode.window.showErrorMessage("Invalid hunk index.");
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const adjustedStartLine = getAdjustedStartLineForHunk(hunkIndex);
        
        // Ensure valid range
        if (adjustedStartLine < 0 || (hunk.oldLines > 0 && adjustedStartLine + hunk.oldLines > editor.document.lineCount)) {
            if (!(hunk.oldLines === 0 && adjustedStartLine <= editor.document.lineCount)) {
                vscode.window.showErrorMessage(`Cannot apply hunk: Invalid line numbers for removal in editor. Adjusted Start: ${adjustedStartLine}, Hunk Old Lines: ${hunk.oldLines}, Total doc lines: ${editor.document.lineCount}`);
                return;
            }
        }
        
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
        if (hunk.newLines === 0 && newTextForHunk === "\n") {
            newTextForHunk = "";
        }

        edit.replace(fileUri, finalRangeToRemove, newTextForHunk);
        
        try {
            const oldLineCount = editor.document.lineCount;
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                const newLineCount = editor.document.lineCount;
                const actualLineDelta = newLineCount - oldLineCount;

                vscode.window.showInformationMessage(`Hunk ${hunkIndex + 1} applied.`);
                appliedHunkIndices.add(hunkIndex);
                netLineChangesByHunkIndex.set(hunkIndex, actualLineDelta);
                
                updateDecorations();
                activeInlineDiffSession.codeLensProvider.refresh();

                const allHunksProcessed = originalFileDiff.chunks.every((_, idx) => 
                    appliedHunkIndices.has(idx) || skippedHunkIndices.has(idx));
                if (allHunksProcessed) {
                    vscode.window.showInformationMessage("All hunks processed.");
                    clearActiveInlineDiffSession();
                }
            } else {
                vscode.window.showErrorMessage(`Failed to apply hunk ${hunkIndex + 1}. The editor might be in an inconsistent state.`);
            }
        } catch (e: any) { 
            vscode.window.showErrorMessage(`Error applying hunk: ${e.message}`);
        }

        // After applying, preview the next unprocessed hunk
        const nextHunkIndex = originalFileDiff.chunks.findIndex((_, idx) =>
            !appliedHunkIndices.has(idx) && !skippedHunkIndices.has(idx)
        );
        if (nextHunkIndex !== -1) {
            await previewHunk(nextHunkIndex);
        }
    });
}

export function registerSkipHunkCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('quick-diff-apply.skipHunk', async (fileUri: vscode.Uri, hunkIndex: number) => {
        if (!activeInlineDiffSession || activeInlineDiffSession.uri.toString() !== fileUri.toString()) return;
        if (activeInlineDiffSession.appliedHunkIndices.has(hunkIndex)) return;

        activeInlineDiffSession.skippedHunkIndices.add(hunkIndex);
        updateDecorations();
        activeInlineDiffSession.codeLensProvider.refresh();

        const { originalFileDiff, appliedHunkIndices, skippedHunkIndices } = activeInlineDiffSession;
        const allHunksProcessed = originalFileDiff.chunks.every((_, idx) => 
            appliedHunkIndices.has(idx) || skippedHunkIndices.has(idx));
        if (allHunksProcessed) {
            vscode.window.showInformationMessage("All hunks processed.");
            clearActiveInlineDiffSession();
        }
        
        // Preview next unprocessed hunk
        const nextHunkIndex = originalFileDiff.chunks.findIndex((_, idx) =>
            !appliedHunkIndices.has(idx) && !skippedHunkIndices.has(idx)
        );
        if (nextHunkIndex !== -1) {
            await previewHunk(nextHunkIndex);
        }
    });
}

export function registerApplyAllRemainingCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('quick-diff-apply.applyAllRemainingInFile', async (fileUri: vscode.Uri) => {
        if (!activeInlineDiffSession || activeInlineDiffSession.uri.toString() !== fileUri.toString()) return;

        const { originalFileDiff, editor, skippedHunkIndices, appliedHunkIndices, netLineChangesByHunkIndex } = activeInlineDiffSession;
        
        // Process hunks in order
        for (let i = 0; i < originalFileDiff.chunks.length; i++) {
            if (appliedHunkIndices.has(i) || skippedHunkIndices.has(i)) {
                continue;
            }

            const hunk = originalFileDiff.chunks[i];
            const edit = new vscode.WorkspaceEdit();
            const adjustedStartLine = getAdjustedStartLineForHunk(i);

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
                const oldLineCount = editor.document.lineCount;
                const success = await vscode.workspace.applyEdit(edit);
                if (success) {
                    const newLineCount = editor.document.lineCount;
                    const actualLineDelta = newLineCount - oldLineCount;

                    appliedHunkIndices.add(i);
                    netLineChangesByHunkIndex.set(i, actualLineDelta);
                } else {
                    vscode.window.showErrorMessage(`Failed to apply hunk ${i + 1} during 'Apply All'.`);
                    updateDecorations();
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
        clearActiveInlineDiffSession();
    });
}

export function registerDiscardAllCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('quick-diff-apply.discardAllInFile', async (fileUri: vscode.Uri) => {
        if (!activeInlineDiffSession || activeInlineDiffSession.uri.toString() !== fileUri.toString()) return;
        clearActiveInlineDiffSession();
        vscode.window.showInformationMessage("Changes discarded for this file.");
    });
}

export function registerApplyDiffCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('quick-diff-apply.applyDiff', async (contextUri?: vscode.Uri) => {
        let tempDir: string | undefined;
        if (activeInlineDiffSession && (!contextUri || activeInlineDiffSession.uri.toString() !== contextUri.toString())) {
            clearActiveInlineDiffSession();
        }

        try {
            const diffText = await vscode.env.clipboard.readText();
            if (!diffText) {
                vscode.window.showWarningMessage('Clipboard is empty.');
                return;
            }
            
            const parsedFiles: File[] = parseDiff(diffText);
            if (parsedFiles.length === 0) {
                vscode.window.showWarningMessage('No diff information found.');
                return;
            }
            
            const workspaceRootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!workspaceRootUri) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
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
            
            // FALLBACK TO vscode.diff PREVIEW
            tempDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'vscode-quick-diff-apply-'));
            const previewsToShow: Array<{ originalUri: vscode.Uri, patchedUri: vscode.Uri, displayName: string, file: File }> = [];

            for (const file of parsedFiles) {
                const targetPath = file.to || file.from;
                if (!targetPath || (targetPath === '/dev/null' && !file.from && !file.to)) continue; 

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
                    const patchedContentFull = applyPatchToContent(originalContent, file);
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
                
                for (const preview of previewsToShow) {
                    const fileDiff = preview.file;
                    const filePathInDiff = fileDiff.to || fileDiff.from;
                    
                    let targetUriInWorkspace: vscode.Uri;
                    if (fileDiff.new && fileDiff.to && fileDiff.to !== '/dev/null') {
                        targetUriInWorkspace = vscode.Uri.joinPath(workspaceRootUri, fileDiff.to);
                    } else if (fileDiff.deleted && fileDiff.from && fileDiff.from !== '/dev/null') {
                        targetUriInWorkspace = vscode.Uri.joinPath(workspaceRootUri, fileDiff.from);
                    } else if (filePathInDiff && filePathInDiff !== '/dev/null') {
                        targetUriInWorkspace = vscode.Uri.joinPath(workspaceRootUri, filePathInDiff);
                    } else {
                        continue;
                    }

                    try {
                        if (fileDiff.new || fileDiff.from === '/dev/null') {
                            const newContent = getNewFileContentFromDiff(fileDiff);
                            try {
                                await vscode.workspace.fs.stat(targetUriInWorkspace);
                                const existingContentBuffer = await vscode.workspace.fs.readFile(targetUriInWorkspace);
                                const existingContentLines = Buffer.from(existingContentBuffer).toString('utf8').split('\n');
                                const fullRange = new vscode.Range(
                                    new vscode.Position(0,0), 
                                    new vscode.Position(existingContentLines.length, existingContentLines[existingContentLines.length-1]?.length || 0)
                                );
                                workspaceEdit.replace(targetUriInWorkspace, fullRange, newContent);
                            } catch (e) {
                                workspaceEdit.createFile(targetUriInWorkspace, { ignoreIfExists: false, contents: Buffer.from(newContent) });
                            }
                            changesAppliedCount++;
                        } else if (fileDiff.deleted || fileDiff.to === '/dev/null') {
                            workspaceEdit.deleteFile(targetUriInWorkspace, { ignoreIfNotExists: true });
                            changesAppliedCount++;
                        } else { 
                            const originalFileContent = Buffer.from(await vscode.workspace.fs.readFile(targetUriInWorkspace)).toString('utf8');
                            const patchedContent = applyPatchToContent(originalFileContent, fileDiff);
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
        } catch (error: any) {
            console.error('Error applying diff:', error);
            vscode.window.showErrorMessage(`Failed to apply diff: ${error.message}`);
        } finally {
            if (tempDir) {
                try { 
                    nodeFs.rmSync(tempDir, { recursive: true, force: true }); 
                } catch (e) { 
                    console.error('Failed to clean up temp dir:', tempDir, e); 
                }
            }
        }
    });
}

export function registerHelloWorldCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('quick-diff-apply.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from Quick Diff Apply is still here!');
    });
}
