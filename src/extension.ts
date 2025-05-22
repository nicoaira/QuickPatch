// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import parseDiff, { File, Chunk, Change } from 'parse-diff'; // Corrected import, added Chunk and Change

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
		try {
			const diffText = await vscode.env.clipboard.readText();
			if (!diffText) {
				vscode.window.showWarningMessage('Clipboard is empty.');
				return;
			}

			const files: File[] = parseDiff(diffText); // Corrected usage and added type
			if (files.length === 0) {
				vscode.window.showWarningMessage('No diff information found in clipboard content.');
				return;
			}

			// --- User Confirmation ---
			const affectedFiles = files.map((file: File) => file.to || file.from || 'unknown'); // Added type for file
			const confirmation = await vscode.window.showInformationMessage(
				`Apply changes to the following files?\n${affectedFiles.join('\n')}`,
				{ modal: true },
				'Proceed'
			);

			if (confirmation !== 'Proceed') {
				vscode.window.showInformationMessage('Diff application cancelled.');
				return;
			}
			// --- End User Confirmation ---


			const workspaceEdit = new vscode.WorkspaceEdit();
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

			if (!workspaceRoot) {
				vscode.window.showErrorMessage('No workspace folder open.');
				return;
			}

			let changesApplied = 0;
			let errorsEncountered = 0;

			for (const file of files) {
				const filePath = file.to || file.from;
				if (!filePath || filePath === '/dev/null') {
					// Handle cases like git new file mode or deleted file mode where one path is /dev/null
					if (file.to === '/dev/null' && file.from) { // File deletion
						const fileUri = vscode.Uri.joinPath(workspaceRoot, file.from);
						try {
							await vscode.workspace.fs.stat(fileUri); // Check if file exists
							workspaceEdit.deleteFile(fileUri, { ignoreIfNotExists: true });
							changesApplied++;
						} catch (e) {
							// File doesn't exist, which is fine for a delete operation in a diff
							// Or it might be a directory, which we are not handling for deletion here.
							console.warn(`Skipping deletion of non-existent or directory: ${file.from}`);
						}
					} else if (file.from === '/dev/null' && file.to) { // File creation
						const fileUri = vscode.Uri.joinPath(workspaceRoot, file.to);
						// Create an empty file first, then apply chunks.
						// parse-diff doesn't give the full new file content directly for new files,
						// so we build it line by line from chunks.
						let newFileContent = '';
						for (const chunk of file.chunks) { // Changed hunks to chunks, chunk type is Chunk
							for (const change of chunk.changes) { // change type is Change
								if (change.type === 'add') {
									newFileContent += change.content.substring(1) + '\n';
								}
							}
						}
						// Remove trailing newline if present, as VS Code might add one
						if (newFileContent.endsWith('\n')) {
							newFileContent = newFileContent.slice(0, -1);
						}
						workspaceEdit.createFile(fileUri, { ignoreIfExists: false, contents: Buffer.from(newFileContent) });
						changesApplied++;
					}
					continue;
				}

				const fileUri = vscode.Uri.joinPath(workspaceRoot, filePath);

				try {
					let originalContent = '';
					let fileExists = false;
					try {
						const fileStat = await vscode.workspace.fs.stat(fileUri);
						if (fileStat.type === vscode.FileType.File) {
							const fileContent = await vscode.workspace.fs.readFile(fileUri);
							originalContent = Buffer.from(fileContent).toString('utf8');
							fileExists = true;
						} else {
							vscode.window.showErrorMessage(`Path exists but is not a file: ${filePath}`);
							errorsEncountered++;
							continue;
						}
					} catch (e) {
						// File does not exist, check if it's a new file in the diff
						if (!(file.new && file.newMode)) {
							vscode.window.showErrorMessage(`File not found and not marked as new: ${filePath}`);
							errorsEncountered++;
							continue;
						}
					}

					if (file.new && file.newMode && !fileExists) { // Creating a new file
						let newFileContent = '';
						file.chunks.forEach((chunk: Chunk) => { // Changed hunks to chunks, explicitly typed chunk
							chunk.changes.forEach((change: Change) => { // Explicitly typed change
								if (change.type === 'add') {
									newFileContent += change.content.substring(1) + '\n';
								}
							});
						});
						// Remove trailing newline if present
						if (newFileContent.endsWith('\n')) {
							newFileContent = newFileContent.slice(0, -1);
						}
						workspaceEdit.createFile(fileUri, { ignoreIfExists: true, contents: Buffer.from(newFileContent) });
						changesApplied++;
					} else if (fileExists) { // Patching an existing file
						const lines = originalContent.split('\n');
						let newLines = [...lines]; // Work on a copy

						// Apply chunks in reverse to avoid line number shifts
						for (let i = file.chunks.length - 1; i >= 0; i--) { // Changed hunks to chunks
							const chunk = file.chunks[i]; // Changed hunk to chunk
							let currentPositionInNewLines = chunk.newStart -1; // 0-indexed

							// Verify chunk applicability (simple check)
                            // A more robust check would compare context lines from the diff with actual file content.
                            // For simplicity, we are trusting the line numbers from the diff.

							const linesToRemove = chunk.changes.filter((c: Change) => c.type === 'del' || c.type === 'normal').length; // Explicitly typed c
							const linesToAdd = chunk.changes.filter((c: Change) => c.type === 'add' || c.type === 'normal').map((c: Change) => c.content.substring(1)); // Explicitly typed c

							newLines.splice(currentPositionInNewLines, linesToRemove, ...linesToAdd);
						}

						const newContent = newLines.join('\n');
						const fullRange = new vscode.Range(
							new vscode.Position(0, 0),
							new vscode.Position(lines.length, lines[lines.length - 1]?.length || 0)
						);
						workspaceEdit.replace(fileUri, fullRange, newContent);
						changesApplied++;
					} else if (file.deleted && file.oldMode && fileExists) { // Deleting a file; Changed delete to deleted
						workspaceEdit.deleteFile(fileUri, { ignoreIfNotExists: true });
						changesApplied++;
					}


				} catch (error: any) {
					console.error(`Error processing file ${filePath}:`, error);
					vscode.window.showErrorMessage(`Failed to process ${filePath}: ${error.message}`);
					errorsEncountered++;
				}
			}

			if (errorsEncountered > 0 && changesApplied > 0) {
				// Partial success, ask user if they want to apply successful changes
				const choice = await vscode.window.showWarningMessage(
					`Encountered ${errorsEncountered} error(s) while processing the diff. ${changesApplied} file(s) can be changed successfully. Apply successful changes?`,
					{ modal: true },
					"Apply Successful", "Discard All"
				);
				if (choice === "Apply Successful") {
					await vscode.workspace.applyEdit(workspaceEdit);
					vscode.window.showInformationMessage(`Diff applied to ${changesApplied} file(s) with ${errorsEncountered} error(s).`);
				} else {
					vscode.window.showInformationMessage('Diff application aborted due to errors.');
				}
			} else if (errorsEncountered > 0 && changesApplied === 0) {
				vscode.window.showErrorMessage(`Failed to apply diff: ${errorsEncountered} error(s) encountered and no files could be changed.`);
			} else if (changesApplied > 0) {
				await vscode.workspace.applyEdit(workspaceEdit);
				vscode.window.showInformationMessage(`Diff applied successfully to ${changesApplied} file(s).`);
			} else {
				vscode.window.showInformationMessage('No changes to apply from the diff.');
			}

		} catch (error: any) {
			console.error('Error applying diff:', error);
			vscode.window.showErrorMessage(`Failed to apply diff: ${error.message}`);
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
