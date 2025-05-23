import * as vscode from 'vscode';
import { clearActiveInlineDiffSession } from './inlineDiffSession';
import { 
    registerApplyHunkOnlyCommand,
    registerSkipHunkCommand,
    registerApplyAllRemainingCommand,
    registerDiscardAllCommand,
    registerApplyDiffCommand,
    registerHelloWorldCommand
} from './commands';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "quick-diff-apply" is now active!');

    // Register all commands
    context.subscriptions.push(
        registerApplyHunkOnlyCommand(),
        registerSkipHunkCommand(),
        registerApplyAllRemainingCommand(),
        registerDiscardAllCommand(),
        registerApplyDiffCommand(),
        registerHelloWorldCommand()
    );
}

// This method is called when your extension is deactivated
export function deactivate() {
    clearActiveInlineDiffSession(); // Ensure cleanup on deactivation
}
