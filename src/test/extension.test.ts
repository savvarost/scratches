import * as assert from 'assert';
import * as vscode from 'vscode';
import { compareFileItems } from '../scratches';

suite('Extension Test Suite', () => {
    test('compareFileItems sorts directories before files', () => {
        const directoryItem = {
            uri: vscode.Uri.file('/tmp/a-folder'),
            type: vscode.FileType.Directory,
        };
        const fileItem = {
            uri: vscode.Uri.file('/tmp/z-file.ts'),
            type: vscode.FileType.File,
        };

        assert.ok(compareFileItems(directoryItem, fileItem) < 0);
    });

    test('compareFileItems keeps numeric names in reverse order', () => {
        const newerNumeric = {
            uri: vscode.Uri.file('/tmp/20241231-log.md'),
            type: vscode.FileType.File,
        };
        const olderNumeric = {
            uri: vscode.Uri.file('/tmp/20240101-log.md'),
            type: vscode.FileType.File,
        };

        assert.ok(compareFileItems(newerNumeric, olderNumeric) < 0);
    });

    test('compareFileItems sorts regular names alphabetically', () => {
        const alpha = {
            uri: vscode.Uri.file('/tmp/alpha.md'),
            type: vscode.FileType.File,
        };
        const beta = {
            uri: vscode.Uri.file('/tmp/beta.md'),
            type: vscode.FileType.File,
        };

        assert.ok(compareFileItems(alpha, beta) < 0);
    });
});
