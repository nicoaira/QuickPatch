import parseDiff, { File, Chunk, Change, NormalChange, DeleteChange, AddChange } from 'parse-diff';

// Helper function to apply patch to content
export function applyPatchToContent(originalContent: string, fileDiff: File): string {
    const lines = originalContent.split('\n');
    let newContent = '';
    let lastLineProcessed = -1;

    fileDiff.chunks.forEach(chunk => {
        // Add unchanged lines before the chunk
        if (chunk.oldStart > 0) {
            for (let i = lastLineProcessed + 1; i < chunk.oldStart -1; i++) {
                newContent += lines[i] + '\n';
            }
        }


        chunk.changes.forEach(change => {
            if (change.type === 'del') {
                // Skip deleted lines
            } else if (change.type === 'add') {
                newContent += change.content.substring(1) + '\n'; // Remove '+' prefix
            } else if (change.type === 'normal') {
                newContent += change.content.substring(1) + '\n'; // Remove ' ' prefix
            }
        });
        if (chunk.changes.length > 0) {
            const lastChange = chunk.changes[chunk.changes.length - 1];
            if (lastChange.type === 'normal') {
                // For normal changes, use ln1 property
                lastLineProcessed = (lastChange as NormalChange).ln1 || lastLineProcessed;
            } else if (lastChange.type === 'del') {
                // For deleted lines, use ln property
                lastLineProcessed = (lastChange as DeleteChange).ln || lastLineProcessed;
            } else if (lastChange.type === 'add') {
                 // For add changes, the original line number context is from the previous normal/del line or chunk.oldStart
                 // This part might need more sophisticated logic if adds are not immediately following a normal/del or start of chunk
                 // However, typical diffs place adds relative to existing lines.
            }
        }
    });

    // Add remaining unchanged lines after the last chunk
    for (let i = lastLineProcessed +1; i < lines.length; i++) {
        newContent += lines[i] + (i < lines.length -1 ? '\n' : ''); // Avoid trailing newline if it's the last line and was not in original
    }
    if (originalContent.endsWith('\n') && !newContent.endsWith('\n') && newContent !== '') {
        newContent += '\n';
    }


    return newContent;
}

export function getNewFileContentFromDiff(fileDiff: File): string {
    let newContent = '';
    fileDiff.chunks.forEach(chunk => {
        chunk.changes.forEach(change => {
            if (change.type === 'add' || change.type === 'normal') {
                newContent += change.content.substring(1) + '\n'; // Remove '+' or ' ' prefix
            }
        });
    });
    // Remove the last newline character if the content is not empty
    if (newContent.length > 0) {
        newContent = newContent.slice(0, -1);
    }
    return newContent;
}
