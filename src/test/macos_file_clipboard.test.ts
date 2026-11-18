import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { pathToFileURL } from 'url';
import { macOSFileClipboard } from '../macos_file_clipboard';
import { DirectoryViewer, FileClipboard } from '../scratches';
import { FileExtensionsManager } from '../file_extension';

suite('macOS file clipboard', () => {
    test('round trips file URLs through a private pasteboard', async function () {
        if (process.platform !== 'darwin') { this.skip(); }
        const board = `org.scratches.test.${crypto.randomUUID()}`;
        const paths = ['/tmp/scratches test.txt', '/tmp/пример #1.txt'];
        const written = await macOSFileClipboard('write', paths, board);
        const read = await macOSFileClipboard('read', [], board);
        assert.deepStrictEqual(read.paths, paths);
        assert.strictEqual(read.changeCount, written.changeCount);
    });

    test('copies between a view and a private file pasteboard', async function () {
        if (process.platform !== 'darwin') { this.skip(); }
        const board = `org.scratches.test.${crypto.randomUUID()}`;
        const root = fs.mkdtempSync(path.join(process.env.SCRATCHES_TEST_TMPDIR || os.tmpdir(), 'scratches-native-'));
        const source = path.join(root, 'source.txt');
        const external = path.join(root, 'external.txt');
        const destination = path.join(root, 'destination');
        fs.mkdirSync(destination);
        fs.writeFileSync(source, 'source');
        fs.writeFileSync(external, 'external');
        const clipboard: FileClipboard = {
            read: async () => { const value = await macOSFileClipboard('read', [], board); return { paths: value.paths ?? [], changeCount: value.changeCount }; },
            write: async paths => macOSFileClipboard('write', paths, board),
        };
        const viewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager, undefined, clipboard);
        try {
            viewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.deepStrictEqual((await clipboard.read()).paths, [source]);
            assert.strictEqual(fs.readFileSync(path.join(destination, 'source.txt'), 'utf8'), 'source');
            await clipboard.write([external]);
            await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(destination, 'external.txt'), 'utf8'), 'external');
            assert.strictEqual(fs.readFileSync(external, 'utf8'), 'external');
        } finally {
            viewer.dispose();
            if (!process.env.SCRATCHES_TEST_TMPDIR) { fs.rmSync(root, { recursive: true, force: true }); }
        }
    });

    test('imports VS Code Explorer file URLs from a private pasteboard', async function () {
        if (process.platform !== 'darwin') { this.skip(); }
        const board = `org.scratches.test.${crypto.randomUUID()}`;
        const root = fs.mkdtempSync(path.join(process.env.SCRATCHES_TEST_TMPDIR || os.tmpdir(), 'scratches-explorer-'));
        const source = path.join(root, 'пример #1.txt');
        const destination = path.join(root, 'destination');
        fs.mkdirSync(destination);
        fs.writeFileSync(source, 'content');
        const clipboard: FileClipboard = {
            read: async () => { const value = await macOSFileClipboard('read', [], board); return { paths: value.paths ?? [], changeCount: value.changeCount }; },
            write: async paths => macOSFileClipboard('write', paths, board),
        };
        const viewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager, undefined, clipboard);
        try {
            await macOSFileClipboard('write-explorer-test', [pathToFileURL(source).toString()], board);
            assert.deepStrictEqual((await clipboard.read()).paths, [source]);
            await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(destination, path.basename(source)), 'utf8'), 'content');
            assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
            await macOSFileClipboard('write-explorer-test', ['https://example.com/file'], board);
            await assert.rejects(clipboard.read(), /Only local file URLs/);
        } finally {
            viewer.dispose();
            if (!process.env.SCRATCHES_TEST_TMPDIR) { fs.rmSync(root, { recursive: true, force: true }); }
        }
    });
});
