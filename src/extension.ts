// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import parseDiff, { File, Chunk, Change } from 'parse-diff'; // Corrected import, added Chunk and Change
import * as nodeFs from 'node:fs'; // Renamed to avoid conflict with vscode.fs
import * as nodePath from 'node:path'; // Renamed to avoid conflict
import * as os from 'node:os'; // Explicitly use node:os

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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "quick-diff-apply" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const applyDiffCommand = vscode.commands.registerCommand('quick-diff-apply.applyDiff', async () => {
        let tempDir: string | undefined;
		try {
			const diffText = await vscode.env.clipboard.readText();
			if (!diffText) {
				vscode.window.showWarningMessage('Clipboard is empty.');
				return;
			}

			const parsedFiles: File[] = parseDiff(diffText);
			if (parsedFiles.length === 0) {
				vscode.window.showWarningMessage('No diff information found in clipboard content.');
				return;
			}

			const workspaceRootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!workspaceRootUri) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            const workspaceRootPath = workspaceRootUri.fsPath;

            // Create a temporary directory for patched files
            tempDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'vscode-quick-diff-apply-'));

            const previewsToShow: Array<{ originalUri: vscode.Uri, patchedUri: vscode.Uri, displayName: string, file: File }> = [];
            const filesToCleanup: vscode.Uri[] = [];

            for (const file of parsedFiles) {
                const targetPath = file.to || file.from;
                if (!targetPath || targetPath === '/dev/null' && !file.from && !file.to ) continue; // Skip if no path info

                let originalUri: vscode.Uri;
                let patchedUri: vscode.Uri;
                let displayName = nodePath.basename(targetPath === '/dev/null' ? (file.from || 'unknown') : targetPath);
                
                const tempOriginalFilePath = nodePath.join(tempDir, `original-${Date.now()}-${displayName}`);
                const tempPatchedFilePath = nodePath.join(tempDir, `patched-${Date.now()}-${displayName}`);

                if (file.new || file.from === '/dev/null') { // New file
                    displayName = nodePath.basename(file.to || 'new-file');
                    const newContent = getNewFileContentFromDiff(file);
                    nodeFs.writeFileSync(tempOriginalFilePath, ''); // Empty original for new file diff
                    nodeFs.writeFileSync(tempPatchedFilePath, newContent);
                    originalUri = vscode.Uri.file(tempOriginalFilePath);
                    patchedUri = vscode.Uri.file(tempPatchedFilePath);
                    filesToCleanup.push(originalUri, patchedUri);
                } else if (file.deleted || file.to === '/dev/null') { // Deleted file
                    displayName = nodePath.basename(file.from || 'deleted-file');
                    const actualFileUri = vscode.Uri.joinPath(workspaceRootUri, file.from!);
                    try {
                        const originalContent = Buffer.from(await vscode.workspace.fs.readFile(actualFileUri)).toString('utf8');
                        nodeFs.writeFileSync(tempOriginalFilePath, originalContent);
                        originalUri = vscode.Uri.file(tempOriginalFilePath); // Show actual content that will be deleted
                    } catch (e) {
                        // If original file doesn't exist, diff original (empty) vs patched (empty)
                        console.warn(`Original file for deletion not found: ${file.from}, showing empty diff.`);
                        nodeFs.writeFileSync(tempOriginalFilePath, '');
                        originalUri = vscode.Uri.file(tempOriginalFilePath);
                    }
                    nodeFs.writeFileSync(tempPatchedFilePath, ''); // Empty patched content for deleted file
                    patchedUri = vscode.Uri.file(tempPatchedFilePath);
                    filesToCleanup.push(originalUri, patchedUri); // originalUri might be a real file if read fails
                } else { // Modified file
                    displayName = nodePath.basename(file.to || file.from || 'modified-file');
                    const actualFileUri = vscode.Uri.joinPath(workspaceRootUri, file.to || file.from!);
                    let originalContent = '';
                    try {
                        originalContent = Buffer.from(await vscode.workspace.fs.readFile(actualFileUri)).toString('utf8');
                    } catch (e) {
                        vscode.window.showWarningMessage(`File not found in workspace, cannot apply patch or show diff: ${file.to || file.from}`);
                        // Optionally, allow creating it as a new file if it doesn't exist but diff implies modification
                        // For now, we skip if original is not found for modification.
                        continue;
                    }
                    const patchedContent = applyPatchToContent(originalContent, file);
                    originalUri = actualFileUri; // Use the actual workspace file for the left side of the diff
                    nodeFs.writeFileSync(tempPatchedFilePath, patchedContent);
                    patchedUri = vscode.Uri.file(tempPatchedFilePath);
                    filesToCleanup.push(patchedUri); // Only temp patched file needs cleanup here
                }
                previewsToShow.push({ originalUri, patchedUri, displayName, file });
            }

            if (previewsToShow.length === 0) {
                vscode.window.showInformationMessage('No changes to preview or apply.');
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
                let errorsEncounteredCount = 0;

                for (const preview of previewsToShow) {
                    const fileDiff = preview.file;
                    const filePathInDiff = fileDiff.to || fileDiff.from;
                    if (!filePathInDiff) continue;

                    const targetUri = vscode.Uri.joinPath(workspaceRootUri, filePathInDiff);

                    try {
                        if (fileDiff.new || fileDiff.from === '/dev/null') {
                            const newContent = getNewFileContentFromDiff(fileDiff);
                            // Check if file already exists to avoid overwrite error from createFile if not desired
                            try {
                                await vscode.workspace.fs.stat(targetUri);
                                // File exists, decide if we should overwrite or error.
                                // For now, let's use replace for simplicity if it exists, or create if not.
                                // This part might need more robust handling based on desired UX.
                                const existingContent = Buffer.from(await vscode.workspace.fs.readFile(targetUri)).toString('utf8').split('\n');
                                const fullRange = new vscode.Range(new vscode.Position(0,0), new vscode.Position(existingContent.length, existingContent[existingContent.length-1]?.length || 0));
                                workspaceEdit.replace(targetUri, fullRange, newContent);
                            } catch (e) {
                                // File does not exist, safe to create
                                workspaceEdit.createFile(targetUri, { ignoreIfExists: false, contents: Buffer.from(newContent) });
                            }
                            changesAppliedCount++;
                        } else if (fileDiff.deleted || fileDiff.to === '/dev/null') {
                            const deleteUri = vscode.Uri.joinPath(workspaceRootUri, fileDiff.from!);
                            workspaceEdit.deleteFile(deleteUri, { ignoreIfNotExists: true });
                            changesAppliedCount++;
                        } else { // Modified file
                            const originalFileContent = Buffer.from(await vscode.workspace.fs.readFile(targetUri)).toString('utf8');
                            const patchedContent = applyPatchToContent(originalFileContent, fileDiff);
                            const originalLines = originalFileContent.split('\n');
                            const fullRange = new vscode.Range(
                                new vscode.Position(0, 0),
                                new vscode.Position(originalLines.length, originalLines[originalLines.length - 1]?.length || 0)
                            );
                            workspaceEdit.replace(targetUri, fullRange, patchedContent);
                            changesAppliedCount++;
                        }
                    } catch (error: any) {
                        console.error(`Error preparing edit for ${filePathInDiff}:`, error);
                        vscode.window.showErrorMessage(`Failed to prepare changes for ${filePathInDiff}: ${error.message}`);
                        errorsEncounteredCount++;
                    }
                }

                if (errorsEncounteredCount > 0 && changesAppliedCount > 0) {
                    const choice = await vscode.window.showWarningMessage(
                        `Encountered ${errorsEncounteredCount} error(s) while preparing changes. ${changesAppliedCount} file(s) can still be applied. Proceed?`,
                        { modal: true },
                        "Apply Successful", "Discard All"
                    );
                    if (choice === "Apply Successful") {
                        await vscode.workspace.applyEdit(workspaceEdit);
                        vscode.window.showInformationMessage(`Diff applied to ${changesAppliedCount} file(s) with ${errorsEncounteredCount} error(s).`);
                    } else {
                        vscode.window.showInformationMessage('Diff application aborted due to errors during preparation.');
                    }
                } else if (errorsEncounteredCount > 0 && changesAppliedCount === 0) {
                    vscode.window.showErrorMessage(`Failed to apply diff: ${errorsEncounteredCount} error(s) encountered and no files could be prepared.`);
                } else if (changesAppliedCount > 0) {
                    await vscode.workspace.applyEdit(workspaceEdit);
                    vscode.window.showInformationMessage(`Diff applied successfully to ${changesAppliedCount} file(s).`);
                } else {
                    vscode.window.showInformationMessage('No changes were applied from the diff.');
                }
            }

		} catch (error: any) {
			console.error('Error applying diff with preview:', error);
			vscode.window.showErrorMessage(`Failed to apply diff with preview: ${error.message}`);
		} finally {
            if (tempDir) {
                try {
                    nodeFs.rmSync(tempDir, { recursive: true, force: true });
                } catch (e) {
                    console.error('Failed to clean up temporary directory:', tempDir, e);
                }
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
export function deactivate() {}
