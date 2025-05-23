import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    // Path to your extension (project root)
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    // Path to the test *suite* entrypoint
    const extensionTestsPath     = path.resolve(__dirname, './suite/index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // VS Code version (optional)
      version: process.env.VSCODE_VERSION
    });
  } catch (err) {
    console.error('❌ Failed to run tests', err);
    process.exit(1);
  }
}

main();
