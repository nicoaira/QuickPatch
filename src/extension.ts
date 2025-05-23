// src/extension.ts

import * as vscode from 'vscode';

// bring in inline-diff session API (including the two pure helpers)
import {
  clearActiveInlineDiffSession,
  applyPatchToContent,
  applySelectedHunksToContent
} from './inlineDiffSession';

// bring in your command-factory functions
import {
  registerApplyHunkOnlyCommand,
  registerSkipHunkCommand,
  registerApplyAllRemainingCommand,
  registerDiscardAllCommand,
  registerApplyDiffCommand,
  registerHelloWorldCommand
} from './commands';

// re-export the two helpers so tests can import them from extension.ts:
export { applyPatchToContent, applySelectedHunksToContent };

export function activate(context: vscode.ExtensionContext) {
  console.log(
    'Congratulations, your extension "quick-diff-apply" is now active!'
  );

  // Register all commands in one call
  context.subscriptions.push(
    registerApplyHunkOnlyCommand(),
    registerSkipHunkCommand(),
    registerApplyAllRemainingCommand(),
    registerDiscardAllCommand(),
    registerApplyDiffCommand(),
    registerHelloWorldCommand()
  );
}

export function deactivate() {
  // clean up inline-diff session state
  clearActiveInlineDiffSession();
}
