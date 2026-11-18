import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getProjectStoragePath } from '../directory';
import { DirectoryViewer, Scratches } from '../scratches';

suite('Workspace lifecycle', () => {
    test('updates an existing project view when the storage root changes', async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspace);
        const first = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-project-first-'));
        const second = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-project-second-'));
        const config = vscode.workspace.getConfiguration('scratches');
        const extension = vscode.extensions.getExtension('scratches.scratches');
        assert.ok(extension);
        try {
            await extension.activate();
            await config.update('path', first, vscode.ConfigurationTarget.Global);
            const views = (Scratches as unknown as { viewers: Map<string, DirectoryViewer> }).viewers;
            const project = views.get('sectionProjectFiles');
            assert.ok(project);
            const firstProject = getProjectStoragePath(first, workspace.uri);
            assert.strictEqual(project.rootPath, firstProject);
            fs.writeFileSync(path.join(firstProject, 'original.txt'), 'original');
            await config.update('path', second, vscode.ConfigurationTarget.Global);
            const secondProject = getProjectStoragePath(second, workspace.uri);
            assert.strictEqual(views.get('sectionProjectFiles'), project);
            assert.strictEqual(project.rootPath, secondProject);
            assert.ok(fs.statSync(secondProject).isDirectory());
            assert.strictEqual(fs.readFileSync(path.join(firstProject, 'original.txt'), 'utf8'), 'original');
            const extraFolder = path.join(second, 'extra-workspace');
            fs.mkdirSync(extraFolder);
            const changed = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { subscription.dispose(); reject(new Error('Workspace event timed out')); }, 5000);
                const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
                    clearTimeout(timer);
                    subscription.dispose();
                    resolve();
                });
            });
            assert.ok(vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(extraFolder) }));
            await changed;
            assert.strictEqual(project.rootPath, secondProject);
            assert.strictEqual(views.get('sectionProjectFiles'), project);
        } finally {
            if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
                vscode.workspace.updateWorkspaceFolders(1, 1);
            }
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(first, { recursive: true, force: true });
            fs.rmSync(second, { recursive: true, force: true });
        }
    });
});
