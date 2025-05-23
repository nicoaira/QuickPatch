# Quick Diff Apply

Quick Diff Apply is a VS Code extension that lets you interactively apply unified diffs from the clipboard, hunk by hunk, with a visual preview.

## Features

- Paste a unified diff and review each hunk before applying.
- See deleted lines in red and inserted lines as green phantom lines.
- Accept or reject each hunk interactively.

## Usage

1. Copy a unified diff to your clipboard.
2. Run the command: `Apply Diff from Clipboard`.
3. Review and apply or reject each hunk as desired.

## Requirements

- VS Code 1.99.0 or newer.

## Extension Settings

None.

## Known Issues

- Phantom lines are a visual simulation; true new lines are not possible with the VS Code API.

## Release Notes

See `CHANGELOG.md`.