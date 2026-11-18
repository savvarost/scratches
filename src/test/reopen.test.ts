import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getProjectStoragePath } from '../directory';
import { DirectoryViewer, Scratches } from '../scratches';

suite('Project after reopening workspace', () => {
    test('uses the first workspace folder and preserves the previous project', async () => {
        const storage = process.env.SCRATCHES_REOPEN_STORAGE;
        const first = process.env.SCRATCHES_REOPEN_FIRST;
        const second = process.env.SCRATCHES_REOPEN_SECOND;
        const stage = process.env.SCRATCHES_REOPEN_STAGE;
        assert.ok(storage && first && second && (stage === 'first' || stage === 'second'));
        const extension = vscode.extensions.getExtension('scratches.scratches');
        assert.ok(extension);
        await extension.activate();
        const project = (Scratches as unknown as { viewers: Map<string, DirectoryViewer> }).viewers.get('sectionProjectFiles');
        assert.ok(project);
        const firstProject = getProjectStoragePath(storage, vscode.Uri.file(first));
        const expected = stage === 'first' ? firstProject : getProjectStoragePath(storage, vscode.Uri.file(second));
        assert.strictEqual(vscode.workspace.workspaceFolders?.[0].uri.fsPath, stage === 'first' ? first : second);
        assert.strictEqual(project.rootPath, expected);
        assert.ok(fs.statSync(expected).isDirectory());
        const marker = path.join(firstProject, 'original.txt');
        if (stage === 'first') { fs.writeFileSync(marker, 'original'); }
        else { assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'original'); }
    });
});
