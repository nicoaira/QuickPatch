// src/test/suite/extension.test.ts
import * as assert from 'assert';
import * as fs     from 'fs';
import * as path   from 'path';
import * as vscode from 'vscode';

import { applyPatchToContent, applySelectedHunksToContent } from '../../extension';

describe('Quick Diff Apply – Unit & Integration Tests', () => {
  /* ────────── unit tests ────────── */
  describe('Pure-function tests', () => {
    it('applyPatchToContent: single-hunk replace', () => {
      const original = 'a\nb\nc\n';
      const fileDiff = {
        chunks: [{
          oldStart: 2, oldLines: 1,
          newStart: 2, newLines: 1,
          changes: [
            { type: 'normal', content: ' b' },
            { type: 'del',    content: '-b' },
            { type: 'add',    content: '+B' }
          ]
        }]
      } as any;
      const result = applyPatchToContent(original, fileDiff);
      assert.strictEqual(result, 'a\nB\nc\n');
    });

    it('applySelectedHunksToContent: pick only hunk 0', () => {
      const original = 'line1\nfoo\nline3\n';
      const allHunks = [{
        oldStart: 2, oldLines: 1, newStart: 2, newLines: 1,
        changes: [
          { type: 'normal', content: ' foo' },
          { type: 'del',    content: '-foo' },
          { type: 'add',    content: '+bar' }
        ]
      }] as any;
      const result = applySelectedHunksToContent(original, allHunks, [0]);
      assert.strictEqual(result, 'line1\nbar\nline3\n');
    });
  });

  /* ────────── integration tests ────────── */
  describe('Integration: VS Code commands + file fixtures', () => {
    /** path now points to *source* tree, not transpiled out/ */
    const fixturesRoot = path.join(__dirname, '../../../src/test/fixtures');

    // Helper: run a fixture end-to-end through the real extension UI
    async function runFixtureTest(name: string) {
      const dir      = path.join(fixturesRoot, name);
      const diffFile = path.join(dir, 'change.diff');
      const diffText = fs.readFileSync(diffFile, 'utf-8');

      // Parse the diff so we know which file it touches
      const parseDiff = require('parse-diff') as typeof import('parse-diff');
      const parsed    = parseDiff(diffText);
      if (parsed.length === 0) {
        throw new Error(`Fixture “${name}” contains no files in its diff`);
      }

      // The actual file to open in the fixture is assumed to be 'original.txt'
      // The paths in the diff (e.g., a/original.txt) are relative to a conceptual git root.
      const sourceFileNameInFixture = 'original.txt'; // Convention for test fixtures
      const origAbs     = path.join(dir, sourceFileNameInFixture);
      const expectedAbs = path.join(dir, 'expected.txt');   // desired result

      // 1) open fixture dir as the *only* workspace folder
      await vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, {
        uri: vscode.Uri.file(dir)
      });

      // 2) put the diff on the clipboard
      await vscode.env.clipboard.writeText(diffText);

      // 3) open the actual source file that the diff applies to
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(origAbs));
      await vscode.window.showTextDocument(doc, { preview: false });

      // 4) start the diff-review flow, passing the URI of the opened document
      await vscode.commands.executeCommand('quick-diff-apply.applyDiff', doc.uri);

      // 5) (non-interactive) accept all remaining hunks
      await vscode.commands.executeCommand(
        'quick-diff-apply.applyAllRemainingInFile',
        doc.uri
      );

      // 6) re-open and compare to the expected result
      // Force save if dirty, then re-read from disk or get latest text
      if (doc.isDirty) {
        await doc.save();
      }
      // It's generally safer to re-read or ensure the TextDocument is updated.
      // Forcing a re-open or getting text from the current doc should be fine if applyEdit updates it.
      const finalDoc = await vscode.workspace.openTextDocument(doc.uri); // Re-open to be safe
      const actual   = finalDoc.getText();
      const expected = fs.readFileSync(expectedAbs, 'utf-8');
      assert.strictEqual(actual, expected, `Fixture "${name}" failed`);
    }

    it('single-hunk replace',       () => runFixtureTest('single-hunk'));
    it('multi-hunk apply in order', () => runFixtureTest('multi-hunk'));
    it('pure-add creates new lines',() => runFixtureTest('pure-add'));
  });
});