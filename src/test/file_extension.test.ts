import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileExtensionsManager } from '../file_extension';

function memoryState(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: (key: string, fallback?: unknown) => values.has(key) ? structuredClone(values.get(key)) : fallback,
        update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    } as vscode.Memento;
}

suite('Extension preferences', () => {
    let root: string;
    let state: vscode.Memento;
    let manager: FileExtensionsManager;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-extensions-'));
        state = memoryState();
        manager = new FileExtensionsManager(state, () => root);
    });
    teardown(() => fs.rmSync(root, { recursive: true, force: true }));

    test('imports the legacy list once without modifying it', async () => {
        const dir = path.join(root, '.vscode');
        fs.mkdirSync(dir);
        const legacy = path.join(dir, '.recentFileExtension.json');
        fs.writeFileSync(legacy, JSON.stringify(['.txt', '.json']));
        assert.deepStrictEqual((await manager.getFileExtensionQuickPickItems(false)).map(item => item.label), ['Extension', '.txt', '.json']);
        fs.writeFileSync(legacy, JSON.stringify(['.other']));
        const reopened = new FileExtensionsManager(state, () => root);
        assert.deepStrictEqual((await reopened.getFileExtensionQuickPickItems(false)).map(item => item.label), ['Extension', '.txt', '.json']);
        assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '[".other"]');
    });

    test('ranks by persisted usage and preserves insertion order for ties', async () => {
        await manager.addFileExtension('.txt');
        await manager.addFileExtension('.json');
        await manager.addFileExtension('.md');
        await Promise.all([manager.recordUsage('.json'), manager.recordUsage('.json'), manager.recordUsage('.md')]);
        const reopened = new FileExtensionsManager(state, () => root);
        assert.deepStrictEqual((await reopened.getFileExtensionQuickPickItems(false)).map(item => item.label), ['Extension', '.json', '.md', '.txt']);
        await reopened.removeFileExtension('.json');
        await reopened.addFileExtension('.json');
        assert.deepStrictEqual((await reopened.getFileExtensionQuickPickItems(false)).map(item => item.label), ['Extension', '.md', '.txt', '.json']);
    });

    test('does not overwrite or mark a damaged legacy file as migrated', async () => {
        fs.mkdirSync(path.join(root, '.vscode'));
        const legacy = path.join(root, '.vscode', '.recentFileExtension.json');
        fs.writeFileSync(legacy, '{broken');
        await assert.rejects(manager.getFileExtensionQuickPickItems());
        assert.strictEqual(state.get('fileExtensions.v1'), undefined);
        assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '{broken');
        fs.writeFileSync(legacy, '[".fixed"]');
        assert.deepStrictEqual((await manager.getFileExtensionQuickPickItems(false)).map(item => item.label), ['Extension', '.fixed']);
    });

    test('refuses a symlink to a legacy list', async function () {
        fs.mkdirSync(path.join(root, '.vscode'));
        try { fs.symlinkSync(path.join(root, 'missing'), path.join(root, '.vscode', '.recentFileExtension.json'), 'file'); }
        catch (error) {
            if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { this.skip(); }
            throw error;
        }
        await assert.rejects(manager.getFileExtensionQuickPickItems());
        assert.strictEqual(state.get('fileExtensions.v1'), undefined);
    });
});
