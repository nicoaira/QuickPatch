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
          oldStart: 2, oldLines: 1, // Affects line 'b'
          newStart: 2, newLines: 1,
          changes: [
            // Corrected: Represents deleting 'b' and adding 'B'
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
        oldStart: 2, oldLines: 1, // Affects line 'foo'
        newStart: 2, newLines: 1,
        changes: [
          // Corrected: Represents deleting 'foo' and adding 'bar'
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

      // 6) Save the document and compare its content to the expected result
      await doc.save(); // Force save to ensure changes are written
      
      // Re-read the file content directly from disk to get the persisted state
      const actual = fs.readFileSync(origAbs, 'utf-8'); 
      const expected = fs.readFileSync(expectedAbs, 'utf-8');
      assert.strictEqual(actual, expected, `Fixture "${name}" failed`);
    }

    it('single-hunk replace',       () => runFixtureTest('single-hunk'));
    it('multi-hunk apply in order', () => runFixtureTest('multi-hunk'));
    it('pure-add creates new lines',() => runFixtureTest('pure-add'));
    it('Test for pair1', () => runFixtureTest('pair1'));
    it('Test for pair2', () => runFixtureTest('pair2'));
    it('Test for pair3', () => runFixtureTest('pair3'));
    it('Test for pair4', () => runFixtureTest('pair4'));
    it('Test for pair5', () => runFixtureTest('pair5'));
    it('Test for pair6', () => runFixtureTest('pair6'));
    it('Test for pair7', () => runFixtureTest('pair7'));
    it('Test for pair8', () => runFixtureTest('pair8'));
  });
});