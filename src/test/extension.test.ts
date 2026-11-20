import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { archiveFiles, canCompareSelection, DirectoryViewer, DirectoryViewerUI, FileClipboard, moveFileExclusive, renameInEditor, Scratches } from '../scratches';
import { FileExtensionsManager } from '../file_extension';
import { ensureProjectStoragePath, expandHomeDirectory, getProjectStoragePath } from '../directory';

function testUI(overrides: Partial<DirectoryViewerUI> = {}): DirectoryViewerUI {
    return {
        input: async () => undefined,
        confirm: async () => undefined,
        openFile: async () => undefined,
        copyText: async () => undefined,
        error: () => undefined,
        warn: () => undefined,
        ...overrides,
    };
}

suite('File operations', () => {
    let root: string;
    let viewer: DirectoryViewer;

    setup(() => {
        root = fs.mkdtempSync(path.join(process.env.SCRATCHES_TEST_TMPDIR || os.tmpdir(), 'scratches-test-'));
        viewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager);
    });

    teardown(() => {
        viewer.dispose();
        // VS Code может ещё завершать наблюдение за открытым файлом; runner удалит профиль после выхода процесса.
        if (!process.env.SCRATCHES_TEST_TMPDIR) { fs.rmSync(root, { recursive: true, force: true }); }
    });

    test('expands only a home-directory prefix in scratch paths', () => {
        assert.strictEqual(expandHomeDirectory('~'), os.homedir());
        assert.strictEqual(expandHomeDirectory('~/scratches'), path.join(os.homedir(), 'scratches'));
        assert.strictEqual(expandHomeDirectory(path.join(root, 'project~old')), path.join(root, 'project~old'));
        assert.strictEqual(expandHomeDirectory('~other/scratches'), '~other/scratches');
        if (path.sep === '\\') {
            assert.strictEqual(expandHomeDirectory('~\\scratches'), path.join(os.homedir(), 'scratches'));
        }
    });

    test('an unsuccessful cut does not turn a previous copy into a move', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination');
        fs.writeFileSync(source, 'content');
        fs.mkdirSync(destination);
        viewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
        viewer.cut({ uri: vscode.Uri.file(destination), type: vscode.FileType.Unknown });
        await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
        assert.strictEqual(fs.readFileSync(path.join(destination, 'source.txt'), 'utf8'), 'content');
    });

    test('a failed file selection preserves the previous clipboard operation', async () => {
        const source = path.join(root, 'source.txt');
        const missing = path.join(root, 'missing.txt');
        const destination = path.join(root, 'destination');
        fs.writeFileSync(source, 'content');
        fs.mkdirSync(destination);
        const errors: string[] = [];
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        try {
            controlledViewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            controlledViewer.cut({ uri: vscode.Uri.file(missing), type: vscode.FileType.File });
            await controlledViewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.ok(errors.some(message => message.includes('Could not select file')));
            assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
            assert.strictEqual(fs.readFileSync(path.join(destination, 'source.txt'), 'utf8'), 'content');
        } finally { controlledViewer.dispose(); }
    });

    test('scratch creation is cancelled if its root changes while selecting an extension', async () => {
        const nextRoot = path.join(root, 'new-root');
        fs.mkdirSync(nextRoot);
        let finishSelection!: (value: string) => void;
        const manager = {
            selectFileExtension: () => new Promise<string>(resolve => { finishSelection = resolve; }),
            recordUsage: async () => undefined,
        };
        const changingViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', manager);
        try {
            const operation = changingViewer.newScratchFile();
            changingViewer.setRootPath(nextRoot);
            finishSelection('.txt');
            await operation;
            assert.deepStrictEqual(fs.readdirSync(nextRoot), []);
            assert.deepStrictEqual(fs.readdirSync(root), ['new-root']);
        } finally { changingViewer.dispose(); }
    });

    test('cancelled creation and a name conflict do not count extension usage', async () => {
        let input: string | undefined;
        let uses = 0;
        const errors: string[] = [];
        const manager = {
            selectFileExtension: async () => '.json',
            recordUsage: async () => { uses++; },
        };
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', manager,
            testUI({ input: async () => input, error: message => { errors.push(message); } }));
        try {
            await controlledViewer.newScratchFile();
            assert.strictEqual(uses, 0);
            fs.writeFileSync(path.join(root, 'existing.json'), 'original');
            input = 'existing.json';
            await controlledViewer.newScratchFile();
            assert.strictEqual(uses, 0);
            assert.strictEqual(fs.readFileSync(path.join(root, input), 'utf8'), 'original');
            assert.ok(errors.some(message => message.includes('Could not create file')));
        } finally { controlledViewer.dispose(); }
    });

    test('creation reports a failed editor open while retaining the created file and count', async () => {
        let uses = 0;
        const errors: string[] = [];
        const manager = {
            selectFileExtension: async () => '.json',
            recordUsage: async () => { uses++; },
        };
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', manager,
            testUI({ input: async () => 'created.json', openFile: async () => { throw new Error('editor unavailable'); },
                error: message => { errors.push(message); } }));
        try {
            await controlledViewer.newScratchFile();
            assert.strictEqual(fs.readFileSync(path.join(root, 'created.json'), 'utf8'), '');
            assert.strictEqual(uses, 1);
            assert.ok(errors.some(message => message.includes('File created, but could not be opened')));
        } finally { controlledViewer.dispose(); }
    });

    test('creation does not count the selected extension if the final name uses another one', async () => {
        let uses = 0;
        const manager = {
            selectFileExtension: async () => '.json',
            recordUsage: async () => { uses++; },
        };
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', manager,
            testUI({ input: async () => 'created.txt' }));
        try {
            await controlledViewer.newScratchFile();
            assert.strictEqual(fs.readFileSync(path.join(root, 'created.txt'), 'utf8'), '');
            assert.strictEqual(uses, 0);
        } finally { controlledViewer.dispose(); }
    });

    test('imports dropped local files and folders without overwriting conflicts', async function () {
        if (process.platform !== 'darwin' || vscode.env.remoteName) { this.skip(); }
        const external = fs.mkdtempSync(path.join(process.env.SCRATCHES_TEST_TMPDIR || os.tmpdir(), 'scratches-drop-'));
        const file = path.join(external, 'file.txt');
        const folder = path.join(external, 'folder');
        fs.writeFileSync(file, 'external'); fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, 'child.txt'), 'child');
        fs.writeFileSync(path.join(root, 'file.txt'), 'existing');
        const warnings: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'sectionSharedFiles', {} as FileExtensionsManager,
            testUI({ warn: message => { warnings.push(message); } }));
        const token = new vscode.CancellationTokenSource();
        try {
            const transfer = new vscode.DataTransfer();
            transfer.set('text/uri-list', new vscode.DataTransferItem([vscode.Uri.file(file), vscode.Uri.file(folder)].map(uri => uri.toString()).join('\r\n')));
            await target.dragController().handleDrop?.(undefined, transfer, token.token);
            assert.strictEqual(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'existing');
            assert.strictEqual(fs.readFileSync(path.join(root, 'folder', 'child.txt'), 'utf8'), 'child');
            assert.strictEqual(fs.readFileSync(file, 'utf8'), 'external');
            assert.ok(warnings.some(message => message.includes('1 failed')));
        } finally { token.dispose(); target.dispose(); fs.rmSync(external, { recursive: true, force: true }); }
    });

    test('drag moves selected items between scratch trees and skips conflicts', async () => {
        const sourceRoot = path.join(root, 'source');
        const destinationRoot = path.join(root, 'destination');
        fs.mkdirSync(sourceRoot); fs.mkdirSync(destinationRoot);
        const file = path.join(sourceRoot, 'file.txt');
        const folder = path.join(sourceRoot, 'folder');
        fs.writeFileSync(file, 'source'); fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, 'child.txt'), 'child');
        fs.writeFileSync(path.join(destinationRoot, 'file.txt'), 'existing');
        const warnings: string[] = [];
        const source = new DirectoryViewer({} as vscode.ExtensionContext, sourceRoot, 'sectionProjectFiles', {} as FileExtensionsManager,
            testUI({ warn: message => { warnings.push(message); } }));
        const destination = new DirectoryViewer({} as vscode.ExtensionContext, destinationRoot, 'sectionSharedFiles', {} as FileExtensionsManager,
            testUI({ warn: message => { warnings.push(message); } }));
        const token = new vscode.CancellationTokenSource();
        try {
            const transfer = new vscode.DataTransfer();
            transfer.set('application/vnd.code.tree.sectionprojectfiles', new vscode.DataTransferItem(''));
            await source.dragController().handleDrag?.([
                { uri: vscode.Uri.file(file), type: vscode.FileType.File },
                { uri: vscode.Uri.file(folder), type: vscode.FileType.Directory },
            ], transfer, token.token);
            await destination.dragController().handleDrop?.(undefined, transfer, token.token);
            assert.strictEqual(fs.readFileSync(file, 'utf8'), 'source');
            assert.strictEqual(fs.readFileSync(path.join(destinationRoot, 'file.txt'), 'utf8'), 'existing');
            assert.strictEqual(fs.readFileSync(path.join(destinationRoot, 'folder', 'child.txt'), 'utf8'), 'child');
            assert.ok(warnings.some(message => message.includes('1 failed')));
        } finally { token.dispose(); source.dispose(); destination.dispose(); }
    });

    test('marks cleanup candidates until confirmation is cancelled', async () => {
        const old = vscode.Uri.file(path.join(root, '20200101-000000.txt'));
        const recent = vscode.Uri.file(path.join(root, '20210101-000000.txt'));
        for (const uri of [old, recent]) {
            fs.writeFileSync(uri.fsPath, 'text');
            fs.utimesSync(uri.fsPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
        }
        let release: (value: string | undefined) => void = () => undefined;
        let ready: () => void = () => undefined;
        const shown = new Promise<void>(resolve => { ready = resolve; });
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ input: async () => '2020-02-01', confirm: () => { ready(); return new Promise(resolve => { release = resolve; }); } }));
        const item = (uri: vscode.Uri) => ({ uri, type: vscode.FileType.File });
        try {
            const operation = target.clear();
            await shown;
            const marker = target.getTreeItem(item(old)).iconPath;
            assert.ok(marker instanceof vscode.ThemeIcon);
            assert.strictEqual(marker.id, 'warning');
            assert.strictEqual(target.getTreeItem(item(recent)).iconPath, undefined);
            release('No');
            await operation;
            assert.strictEqual(target.getTreeItem(item(old)).iconPath, undefined);
            assert.ok(fs.existsSync(old.fsPath));
        } finally { target.dispose(); }
    });

    test('clear skips invalid calendar dates while accepting leap days', async () => {
        const valid = '20200229-000000.txt';
        const invalid = '20200230-000000.txt';
        for (const name of [valid, invalid]) {
            const file = path.join(root, name);
            fs.writeFileSync(file, name);
            fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
        }
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ input: async () => '2021-01-01', confirm: async () => 'Yes' }));
        try {
            await controlledViewer.clear();
            assert.strictEqual(fs.readFileSync(path.join(root, invalid), 'utf8'), invalid);
            assert.strictEqual(fs.readFileSync(path.join(root, 'trash', valid), 'utf8'), valid);
        } finally { controlledViewer.dispose(); }
    });

    test('clear cancels without moving files when a candidate cannot be inspected', async () => {
        const names = ['20200101-000000.txt', '20200102-000000.txt'];
        for (const name of names) {
            const file = path.join(root, name);
            fs.writeFileSync(file, name);
            fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
        }
        const errors: string[] = [];
        let confirmations = 0;
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ input: async () => '2021-01-01', confirm: async () => { confirmations++; return 'Yes'; },
                error: message => { errors.push(message); } }));
        const originalLstat = fs.promises.lstat;
        fs.promises.lstat = (async (...args: Parameters<typeof fs.promises.lstat>) => {
            if (args[0] === path.join(root, names[1])) { throw new Error('inspection failed'); }
            return originalLstat(...args);
        }) as typeof fs.promises.lstat;
        try {
            await controlledViewer.clear();
            assert.strictEqual(confirmations, 0);
            assert.ok(errors.some(message => message.includes('cleanup cancelled') && message.includes(names[1])));
            for (const name of names) { assert.strictEqual(fs.readFileSync(path.join(root, name), 'utf8'), name); }
            assert.strictEqual(fs.existsSync(path.join(root, 'trash')), false);
        } finally { fs.promises.lstat = originalLstat; controlledViewer.dispose(); }
    });

    test('clear stops remaining moves when the root changes during cleanup', async () => {
        const names = ['20200101-000000.txt', '20200102-000000.txt'];
        const nextRoot = path.join(root, 'new-root');
        fs.mkdirSync(nextRoot);
        for (const name of names) {
            const file = path.join(root, name);
            fs.writeFileSync(file, name);
            fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
        }
        const warnings: string[] = [];
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ input: async () => '2021-01-01', confirm: async () => 'Yes', warn: message => { warnings.push(message); } }));
        const originalUnlink = fs.promises.unlink;
        let movedName: string | undefined;
        fs.promises.unlink = async file => {
            await originalUnlink(file);
            if (typeof file === 'string' && names.includes(path.basename(file))) {
                movedName = path.basename(file);
                controlledViewer.setRootPath(nextRoot);
            }
        };
        try {
            await controlledViewer.clear();
            assert.ok(movedName);
            const remaining = names.find(name => name !== movedName);
            assert.ok(remaining);
            assert.strictEqual(fs.readFileSync(path.join(root, 'trash', movedName), 'utf8'), movedName);
            assert.strictEqual(fs.readFileSync(path.join(root, remaining), 'utf8'), remaining);
            assert.strictEqual(fs.existsSync(path.join(root, 'trash', remaining)), false);
            assert.ok(warnings.some(message => message.includes('Scratch directory changed') && message.includes('Moved 1 files')));
        } finally { fs.promises.unlink = originalUnlink; controlledViewer.dispose(); }
    });

    test('clear cancels when the root changes while confirmation is pending', async () => {
        const file = path.join(root, '20200101-000000.txt');
        const nextRoot = path.join(root, 'new-root');
        fs.writeFileSync(file, 'original');
        fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
        fs.mkdirSync(nextRoot);
        let answer!: (value: string) => void;
        let entered!: () => void;
        const confirmationShown = new Promise<void>(resolve => { entered = resolve; });
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ input: async () => '2021-01-01', confirm: () => {
                entered();
                return new Promise<string>(resolve => { answer = resolve; });
            } }));
        try {
            const operation = controlledViewer.clear();
            await confirmationShown;
            controlledViewer.setRootPath(nextRoot);
            answer('Yes');
            await operation;
            assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original');
            assert.strictEqual(fs.existsSync(path.join(root, 'trash')), false);
            assert.deepStrictEqual(fs.readdirSync(nextRoot), []);
        } finally { controlledViewer.dispose(); }
    });

    test('tree hides symbolic links and tolerates broken links', async function () {
        fs.writeFileSync(path.join(root, 'visible.txt'), 'content');
        try { fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'broken'), 'file'); }
        catch (error) {
            if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { this.skip(); }
            throw error;
        }
        const items = await viewer.getChildren();
        assert.deepStrictEqual(items.map(item => path.basename(item.uri.fsPath)), ['visible.txt']);
    });

    test('open and copy path use the selected regular file', async () => {
        const file = path.join(root, 'file.txt');
        fs.writeFileSync(file, 'content');
        const opened: Array<{ file: string; preserveFocus?: boolean }> = [];
        const copied: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ openFile: async (name, preserveFocus) => { opened.push({ file: name, preserveFocus }); },
                copyText: async text => { copied.push(text); } }));
        try {
            const item = { uri: vscode.Uri.file(file), type: vscode.FileType.File };
            await target.open(item);
            await target.copyPath(null);
            assert.deepStrictEqual(opened, [{ file, preserveFocus: true }]);
            assert.deepStrictEqual(copied, [file]);
        } finally { target.dispose(); }
    });

    test('open displays a regular file in the VS Code editor', async () => {
        const file = path.join(root, 'file.txt');
        fs.writeFileSync(file, 'content');
        try {
            await viewer.open({ uri: vscode.Uri.file(file), type: vscode.FileType.File });
            assert.ok(vscode.window.visibleTextEditors.some(editor => editor.document.uri.fsPath === file));
        } finally { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); }
    });

    test('open and copy path reject an item replaced by a symbolic link', async function () {
        const file = path.join(root, 'file.txt');
        const external = path.join(root, 'external.txt');
        fs.writeFileSync(file, 'content');
        fs.writeFileSync(external, 'outside');
        fs.unlinkSync(file);
        try { fs.symlinkSync(external, file, 'file'); }
        catch (error) {
            if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { this.skip(); }
            throw error;
        }
        const errors: string[] = [];
        const opened: string[] = [];
        const copied: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ openFile: async name => { opened.push(name); }, copyText: async text => { copied.push(text); },
                error: message => { errors.push(message); } }));
        try {
            const item = { uri: vscode.Uri.file(file), type: vscode.FileType.File };
            await target.open(item);
            await target.copyPath(item);
            assert.deepStrictEqual(opened, []);
            assert.deepStrictEqual(copied, []);
            assert.strictEqual(errors.length, 2);
            assert.strictEqual(fs.readFileSync(external, 'utf8'), 'outside');
        } finally { target.dispose(); }
    });

    test('open and copy path report editor and clipboard errors', async () => {
        const file = path.join(root, 'file.txt');
        fs.writeFileSync(file, 'content');
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ openFile: async () => { throw new Error('editor unavailable'); },
                copyText: async () => { throw new Error('clipboard unavailable'); },
                error: message => { errors.push(message); } }));
        try {
            const item = { uri: vscode.Uri.file(file), type: vscode.FileType.File };
            await target.open(item);
            await target.copyPath(item);
            assert.ok(errors.some(message => message.includes('editor unavailable')));
            assert.ok(errors.some(message => message.includes('clipboard unavailable')));
        } finally { target.dispose(); }
    });

    test('open and copy path reject an item outside the view root', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-outside-'));
        const file = path.join(outside, 'file.txt');
        fs.writeFileSync(file, 'content');
        const errors: string[] = [];
        const opened: string[] = [];
        const copied: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ openFile: async name => { opened.push(name); }, copyText: async text => { copied.push(text); },
                error: message => { errors.push(message); } }));
        try {
            const item = { uri: vscode.Uri.file(file), type: vscode.FileType.File };
            await target.open(item);
            await target.copyPath(item);
            assert.deepStrictEqual(opened, []);
            assert.deepStrictEqual(copied, []);
            assert.ok(errors.every(message => message.includes('outside the scratch directory')));
            assert.strictEqual(errors.length, 2);
        } finally {
            target.dispose();
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('system clipboard copy and paste import external files without overwriting conflicts', async () => {
        let content = { paths: [] as string[], changeCount: 0 };
        const clipboard: FileClipboard = {
            read: async () => content,
            write: async paths => { content = { paths, changeCount: content.changeCount + 1 }; return content; },
        };
        const warnings: string[] = [];
        const source = path.join(root, 'source.txt');
        const external = path.join(root, 'external.txt');
        const destination = path.join(root, 'destination');
        fs.writeFileSync(source, 'source');
        fs.writeFileSync(external, 'external');
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'source.txt'), 'existing');
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ warn: message => { warnings.push(message); } }), clipboard);
        try {
            target.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.deepStrictEqual(content.paths, [source]);
            assert.strictEqual(fs.readFileSync(path.join(destination, 'source.txt'), 'utf8'), 'existing');
            content = { paths: [source, external], changeCount: content.changeCount + 1 };
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(destination, 'source.txt'), 'utf8'), 'existing');
            assert.strictEqual(fs.readFileSync(path.join(destination, 'external.txt'), 'utf8'), 'external');
            assert.ok(warnings.some(message => message.includes('1 failed')));
            assert.strictEqual(fs.readFileSync(external, 'utf8'), 'external');
        } finally { target.dispose(); }
    });

    test('a failed clipboard write does not paste stale external files', async () => {
        const source = path.join(root, 'source.txt');
        const stale = path.join(root, 'stale.txt');
        const destination = path.join(root, 'destination');
        fs.writeFileSync(source, 'source');
        fs.writeFileSync(stale, 'stale');
        fs.mkdirSync(destination);
        const errors: string[] = [];
        const clipboard: FileClipboard = {
            read: async () => ({ paths: [stale], changeCount: 1 }),
            write: async () => { throw new Error('clipboard unavailable'); },
        };
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }), clipboard);
        try {
            target.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.deepStrictEqual(fs.readdirSync(destination), []);
            assert.ok(errors.some(message => message.includes('Clipboard write failed')));
        } finally { target.dispose(); }
    });

    test('an external clipboard change overrides an earlier internal cut', async () => {
        let content = { paths: [] as string[], changeCount: 0 };
        let notifyWrite!: () => void;
        const written = new Promise<void>(resolve => { notifyWrite = resolve; });
        const clipboard: FileClipboard = { read: async () => content, write: async () => { notifyWrite(); return content; } };
        const source = path.join(root, 'source.txt');
        const external = path.join(root, 'external.txt');
        const destination = path.join(root, 'destination');
        fs.writeFileSync(source, 'source');
        fs.writeFileSync(external, 'external');
        fs.mkdirSync(destination);
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager, testUI(), clipboard);
        try {
            target.cut({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            await written;
            await Promise.resolve();
            content = { paths: [external], changeCount: 1 };
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(source, 'utf8'), 'source');
            assert.strictEqual(fs.readFileSync(external, 'utf8'), 'external');
            assert.strictEqual(fs.readFileSync(path.join(destination, 'external.txt'), 'utf8'), 'external');
            assert.strictEqual(fs.existsSync(path.join(destination, 'source.txt')), false);
        } finally { target.dispose(); }
    });

    test('keyboard copy uses the complete selection', async () => {
        const destination = path.join(root, 'destination');
        fs.mkdirSync(destination);
        const items = ['first.txt', 'second.txt'].map(name => {
            const file = path.join(root, name);
            fs.writeFileSync(file, name);
            return { uri: vscode.Uri.file(file), type: vscode.FileType.File };
        });
        viewer.selectedItems = items;
        viewer.selectItem = items[0];
        viewer.copy(null);
        await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
        assert.deepStrictEqual(fs.readdirSync(destination).sort(), ['first.txt', 'second.txt']);
    });

    for (const action of ['copy', 'cut'] as const) {
        test(`${action} skips conflicting batch items and permits retrying them`, async () => {
            const source = path.join(root, 'source');
            const destination = path.join(root, 'destination');
            const retry = path.join(root, 'retry');
            fs.mkdirSync(source);
            fs.mkdirSync(destination);
            fs.mkdirSync(retry);
            fs.writeFileSync(path.join(destination, 'first.txt'), 'existing');
            const items = ['first.txt', 'second.txt'].map(name => {
                const file = path.join(source, name);
                fs.writeFileSync(file, name);
                return { uri: vscode.Uri.file(file), type: vscode.FileType.File };
            });
            const warnings: string[] = [];
            const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
                testUI({ warn: message => { warnings.push(message); } }));
            try {
                target[action](items[0], items);
                await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
                assert.strictEqual(fs.readFileSync(path.join(destination, 'first.txt'), 'utf8'), 'existing');
                assert.strictEqual(fs.readFileSync(path.join(destination, 'second.txt'), 'utf8'), 'second.txt');
                assert.strictEqual(fs.readFileSync(path.join(source, 'first.txt'), 'utf8'), 'first.txt');
                assert.ok(warnings.some(message => message.includes('1 failed')));
                await target.paste({ uri: vscode.Uri.file(retry), type: vscode.FileType.Directory });
                assert.strictEqual(fs.readFileSync(path.join(retry, 'first.txt'), 'utf8'), 'first.txt');
                assert.strictEqual(fs.existsSync(path.join(retry, 'second.txt')), false);
            } finally { target.dispose(); }
        });
    }

    for (const action of ['copy', 'cut'] as const) {
        test(`${action} transfers multiple selected files`, async () => {
            const names = ['first.txt', 'second.txt'];
            const destination = path.join(root, 'destination');
            fs.mkdirSync(destination);
            const items = names.map(name => {
                const file = path.join(root, name);
                fs.writeFileSync(file, name);
                return { uri: vscode.Uri.file(file), type: vscode.FileType.File };
            });
            viewer[action](items[0], items);
            await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            for (const name of names) {
                assert.strictEqual(fs.readFileSync(path.join(destination, name), 'utf8'), name);
                assert.strictEqual(fs.existsSync(path.join(root, name)), action === 'copy');
            }
        });
    }

    for (const action of ['copy', 'cut'] as const) {
        test(`${action} transfers a folder and its nested files`, async () => {
            const source = path.join(root, 'source');
            const destination = path.join(root, 'destination');
            fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
            fs.mkdirSync(destination);
            fs.writeFileSync(path.join(source, 'nested', 'file.txt'), 'content');
            viewer[action]({ uri: vscode.Uri.file(source), type: vscode.FileType.Directory });
            await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(destination, 'source', 'nested', 'file.txt'), 'utf8'), 'content');
            assert.strictEqual(fs.existsSync(source), action === 'copy');
        });
    }

    test('publishes multiple selected files and folders to the file clipboard', async () => {
        let content = { paths: [] as string[], changeCount: 0 };
        const clipboard: FileClipboard = { read: async () => content,
            write: async paths => { content = { paths, changeCount: content.changeCount + 1 }; return content; } };
        const file = path.join(root, 'file.txt');
        const folder = path.join(root, 'folder');
        const destination = path.join(root, 'destination');
        fs.writeFileSync(file, 'file');
        fs.mkdirSync(folder);
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(folder, 'inside.txt'), 'inside');
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager, testUI(), clipboard);
        const items = [{ uri: vscode.Uri.file(file), type: vscode.FileType.File },
            { uri: vscode.Uri.file(folder), type: vscode.FileType.Directory }];
        try {
            await target.copy(items[0], items);
            assert.deepStrictEqual(content.paths, [file, folder]);
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(destination, 'file.txt'), 'utf8'), 'file');
            assert.strictEqual(fs.readFileSync(path.join(destination, 'folder', 'inside.txt'), 'utf8'), 'inside');
        } finally { target.dispose(); }
    });

    test('imports a folder from the file clipboard', async () => {
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(source, 'nested', 'file.txt'), 'content');
        const clipboard: FileClipboard = { read: async () => ({ paths: [source], changeCount: 500 }),
            write: async () => ({ changeCount: 500 }) };
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager, testUI(), clipboard);
        try {
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(destination, 'source', 'nested', 'file.txt'), 'utf8'), 'content');
            assert.strictEqual(fs.readFileSync(path.join(source, 'nested', 'file.txt'), 'utf8'), 'content');
        } finally { target.dispose(); }
    });

    test('folder copy rejects symbolic links and leaves the source intact', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        const outside = path.join(root, 'outside.txt');
        fs.mkdirSync(source);
        fs.mkdirSync(destination);
        fs.writeFileSync(outside, 'outside');
        fs.symlinkSync(outside, path.join(source, 'link'));
        const warnings: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ warn: message => { warnings.push(message); } }));
        try {
            target.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.Directory });
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.ok(warnings.some(message => message.includes('Symbolic links')));
            assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside');
            assert.strictEqual(fs.existsSync(path.join(destination, 'source', 'link')), false);
        } finally { target.dispose(); }
    });

    test('folder copy refuses unsaved documents inside the folder', async () => {
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        fs.mkdirSync(source);
        fs.mkdirSync(destination);
        const file = vscode.Uri.file(path.join(source, 'file.txt'));
        fs.writeFileSync(file.fsPath, 'content');
        const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'unsaved'));
        const warnings: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ warn: message => { warnings.push(message); } }));
        try {
            target.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.Directory });
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.existsSync(path.join(destination, 'source')), false);
            assert.ok(warnings.some(message => message.includes('unsaved')));
        } finally {
            target.dispose();
            await vscode.commands.executeCommand('workbench.action.files.revert');
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('folder move preserves both folders when the destination already exists', async () => {
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        fs.mkdirSync(source);
        fs.mkdirSync(path.join(destination, 'source'), { recursive: true });
        fs.writeFileSync(path.join(source, 'file.txt'), 'original');
        fs.writeFileSync(path.join(destination, 'source', 'file.txt'), 'existing');
        const warnings: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ warn: message => { warnings.push(message); } }));
        try {
            target.cut({ uri: vscode.Uri.file(source), type: vscode.FileType.Directory });
            await target.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'original');
            assert.strictEqual(fs.readFileSync(path.join(destination, 'source', 'file.txt'), 'utf8'), 'existing');
            assert.ok(warnings.some(message => message.includes('1 failed')));
        } finally { target.dispose(); }
    });

    test('folder move updates an open file editor', async () => {
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        fs.mkdirSync(source);
        fs.mkdirSync(destination);
        const file = vscode.Uri.file(path.join(source, 'file.txt'));
        fs.writeFileSync(file.fsPath, 'content');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
        try {
            viewer.cut({ uri: vscode.Uri.file(source), type: vscode.FileType.Directory });
            await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            const moved = path.join(destination, 'source', 'file.txt');
            assert.strictEqual(fs.readFileSync(moved, 'utf8'), 'content');
            assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
                tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === moved)));
        } finally { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); }
    });

    test('copying a selected folder and its child copies the child only inside the folder', async () => {
        const folder = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        fs.mkdirSync(folder);
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(folder, 'child.txt'), 'content');
        const items = [{ uri: vscode.Uri.file(folder), type: vscode.FileType.Directory },
            { uri: vscode.Uri.file(path.join(folder, 'child.txt')), type: vscode.FileType.File }];
        viewer.copy(items[0], items);
        await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
        assert.strictEqual(fs.readFileSync(path.join(destination, 'source', 'child.txt'), 'utf8'), 'content');
        assert.strictEqual(fs.existsSync(path.join(destination, 'child.txt')), false);
    });

    test('folder copy refuses to copy into itself', async () => {
        const source = path.join(root, 'source');
        const nested = path.join(source, 'nested');
        fs.mkdirSync(nested, { recursive: true });
        const warnings: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ warn: message => { warnings.push(message); } }));
        try {
            target.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.Directory });
            await target.paste({ uri: vscode.Uri.file(nested), type: vscode.FileType.Directory });
            assert.strictEqual(fs.existsSync(path.join(nested, 'source')), false);
            assert.ok(warnings.some(message => message.includes('into itself')));
        } finally { target.dispose(); }
    });

    test('paste preserves an existing destination and source', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination');
        fs.writeFileSync(source, 'source');
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'source.txt'), 'existing');
        viewer.cut({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
        await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'source');
        assert.strictEqual(fs.readFileSync(path.join(destination, 'source.txt'), 'utf8'), 'existing');
    });

    for (const action of ['copy', 'cut'] as const) {
        test(`${action} refuses a different file substituted after selection`, async () => {
            const source = path.join(root, 'source.txt');
            const backup = path.join(root, 'original.txt');
            const destinationRoot = path.join(root, 'destination');
            fs.mkdirSync(destinationRoot);
            fs.writeFileSync(source, 'original');
            const errors: string[] = [];
            const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
                testUI({ error: message => { errors.push(message); } }));
            try {
                viewer[action]({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
                fs.renameSync(source, backup);
                fs.writeFileSync(source, 'replacement');
                await target.paste({ uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory });
                assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'original');
                assert.strictEqual(fs.readFileSync(source, 'utf8'), 'replacement');
                assert.strictEqual(fs.existsSync(path.join(destinationRoot, 'source.txt')), false);
                assert.ok(errors.some(message => message.includes('Selected source was replaced')));
            } finally { target.dispose(); }
        });
    }

    test('copy permits a selected file to be edited in place before pasting', async () => {
        const source = path.join(root, 'source.txt');
        const destinationRoot = path.join(root, 'destination');
        fs.mkdirSync(destinationRoot);
        fs.writeFileSync(source, 'original');
        viewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
        fs.writeFileSync(source, 'updated');
        await viewer.paste({ uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory });
        assert.strictEqual(fs.readFileSync(path.join(destinationRoot, 'source.txt'), 'utf8'), 'updated');
    });

    test('copy reports source changes and retains the clipboard for retry', async () => {
        const source = path.join(root, 'source.txt');
        const destinationRoot = path.join(root, 'destination');
        const retryRoot = path.join(root, 'retry');
        fs.mkdirSync(destinationRoot);
        fs.mkdirSync(retryRoot);
        fs.writeFileSync(source, 'original');
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        const originalCopy = fs.promises.copyFile;
        fs.promises.copyFile = async (from, to, flags) => {
            await originalCopy(from, to, flags);
            if (from === source && to === path.join(destinationRoot, 'source.txt')) {
                await fs.promises.appendFile(source, ' changed');
            }
        };
        try {
            viewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            await target.paste({ uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(destinationRoot, 'source.txt'), 'utf8'), 'original');
            assert.ok(errors.some(message => message.includes('Source changed during copying')));
            fs.promises.copyFile = originalCopy;
            await target.paste({ uri: vscode.Uri.file(retryRoot), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(retryRoot, 'source.txt'), 'utf8'), 'original changed');
        } finally {
            fs.promises.copyFile = originalCopy;
            target.dispose();
        }
    });

    test('copy refuses unsaved changes and succeeds after saving', async () => {
        const source = vscode.Uri.file(path.join(root, 'source.txt'));
        const destinationRoot = path.join(root, 'destination');
        fs.mkdirSync(destinationRoot);
        fs.writeFileSync(source.fsPath, 'original');
        const document = await vscode.workspace.openTextDocument(source);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'changed '));
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        try {
            viewer.copy({ uri: source, type: vscode.FileType.File });
            const destination = { uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory };
            await target.paste(destination);
            assert.strictEqual(fs.existsSync(path.join(destinationRoot, 'source.txt')), false);
            assert.ok(document.isDirty);
            assert.ok(errors.some(message => message.includes('Save unsaved documents before copying')));
            assert.strictEqual(await document.save(), true);
            await target.paste(destination);
            assert.strictEqual(fs.readFileSync(path.join(destinationRoot, 'source.txt'), 'utf8'), 'changed original');
        } finally {
            target.dispose();
            if (document.isDirty) { await vscode.commands.executeCommand('workbench.action.files.revert'); }
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('copy reports unsaved changes that appear while copying', async () => {
        const source = vscode.Uri.file(path.join(root, 'source.txt'));
        const destinationRoot = path.join(root, 'destination');
        const destination = path.join(destinationRoot, 'source.txt');
        fs.mkdirSync(destinationRoot);
        fs.writeFileSync(source.fsPath, 'original');
        const document = await vscode.workspace.openTextDocument(source);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        const originalCopy = fs.promises.copyFile;
        fs.promises.copyFile = async (from, to, flags) => {
            await originalCopy(from, to, flags);
            if (from === source.fsPath && to === destination) {
                await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'changed '));
            }
        };
        try {
            viewer.copy({ uri: source, type: vscode.FileType.File });
            await target.paste({ uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory });
            assert.ok(document.isDirty);
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'original');
            assert.ok(errors.some(message => message.includes('Source has unsaved changes')));
        } finally {
            fs.promises.copyFile = originalCopy;
            target.dispose();
            if (document.isDirty) { await vscode.commands.executeCommand('workbench.action.files.revert'); }
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('copy failure warns that the destination may be incomplete', async () => {
        const source = path.join(root, 'source.txt');
        const destinationRoot = path.join(root, 'destination');
        const destination = path.join(destinationRoot, 'source.txt');
        fs.mkdirSync(destinationRoot);
        fs.writeFileSync(source, 'original');
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        const originalCopy = fs.promises.copyFile;
        fs.promises.copyFile = async (from, to, flags) => {
            if (from === source && to === destination) {
                fs.writeFileSync(destination, 'partial');
                throw new Error('disk full');
            }
            return originalCopy(from, to, flags);
        };
        try {
            viewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            await target.paste({ uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(source, 'utf8'), 'original');
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'partial');
            assert.ok(errors.some(message => message.includes('destination may be incomplete')));
        } finally {
            fs.promises.copyFile = originalCopy;
            target.dispose();
        }
    });

    test('paste refuses a destination reached through a symbolic link', async function () {
        const source = path.join(root, 'source.txt');
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-outside-'));
        try {
            fs.writeFileSync(source, 'source');
            const link = path.join(root, 'link');
            try { fs.symlinkSync(outside, link, 'dir'); }
            catch (error) {
                if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { this.skip(); }
                throw error;
            }
            viewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            await viewer.paste({ uri: vscode.Uri.file(link), type: vscode.FileType.Directory });
            assert.deepStrictEqual(fs.readdirSync(outside), []);
            assert.strictEqual(fs.readFileSync(source, 'utf8'), 'source');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('paste rejects a destination root replaced through an ancestor link', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const parent = path.join(root, 'parent');
        const backup = path.join(root, 'old-parent');
        const replacement = path.join(root, 'replacement');
        fs.mkdirSync(path.join(parent, 'view'), { recursive: true });
        fs.mkdirSync(path.join(replacement, 'view'), { recursive: true });
        const targetViewer = new DirectoryViewer({} as vscode.ExtensionContext, path.join(parent, 'view'), 'test', {} as FileExtensionsManager);
        const source = path.join(root, 'source.txt');
        fs.writeFileSync(source, 'content');
        try {
            viewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            fs.renameSync(parent, backup);
            fs.symlinkSync(replacement, parent, 'dir');
            await targetViewer.paste(null);
            assert.deepStrictEqual(fs.readdirSync(path.join(replacement, 'view')), []);
            assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
        } finally { targetViewer.dispose(); }
    });

    test('paste rejects a source root replaced after copying', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const parent = path.join(root, 'parent');
        const backup = path.join(root, 'old-parent');
        const replacement = path.join(root, 'replacement');
        const sourceRoot = path.join(parent, 'view');
        fs.mkdirSync(sourceRoot, { recursive: true });
        fs.mkdirSync(path.join(replacement, 'view'), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, 'source.txt'), 'original');
        fs.writeFileSync(path.join(replacement, 'view', 'source.txt'), 'replacement');
        const sourceViewer = new DirectoryViewer({} as vscode.ExtensionContext, sourceRoot, 'test', {} as FileExtensionsManager);
        try {
            sourceViewer.copy({ uri: vscode.Uri.file(path.join(sourceRoot, 'source.txt')), type: vscode.FileType.File });
            fs.renameSync(parent, backup);
            fs.symlinkSync(replacement, parent, 'dir');
            await viewer.paste(null);
            assert.strictEqual(fs.existsSync(path.join(root, 'source.txt')), false);
            assert.strictEqual(fs.readFileSync(path.join(backup, 'view', 'source.txt'), 'utf8'), 'original');
            assert.strictEqual(fs.readFileSync(path.join(replacement, 'view', 'source.txt'), 'utf8'), 'replacement');
        } finally { sourceViewer.dispose(); }
    });

    test('tree discards a directory listing if its root is replaced during reading', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const parent = path.join(root, 'parent');
        const replacement = path.join(root, 'replacement');
        const viewRoot = path.join(parent, 'view');
        fs.mkdirSync(viewRoot, { recursive: true });
        fs.mkdirSync(path.join(replacement, 'view'), { recursive: true });
        fs.writeFileSync(path.join(viewRoot, 'original.txt'), 'original');
        const targetViewer = new DirectoryViewer({} as vscode.ExtensionContext, viewRoot, 'test', {} as FileExtensionsManager);
        const originalReaddir = fs.promises.readdir;
        let notifyRead!: () => void;
        let release!: () => void;
        const read = new Promise<void>(resolve => { notifyRead = resolve; });
        const waitForReplacement = new Promise<void>(resolve => { release = resolve; });
        fs.promises.readdir = (async (...args: Parameters<typeof fs.promises.readdir>) => {
            const result = await originalReaddir(...args);
            if (args[0] === viewRoot) {
                notifyRead();
                await waitForReplacement;
            }
            return result;
        }) as typeof fs.promises.readdir;
        try {
            const operation = targetViewer.getChildren();
            await read;
            fs.renameSync(parent, path.join(root, 'old-parent'));
            fs.symlinkSync(replacement, parent, 'dir');
            release();
            assert.deepStrictEqual(await operation, []);
        } finally {
            release();
            fs.promises.readdir = originalReaddir;
            targetViewer.dispose();
        }
    });

    test('copy reports a changed source root and keeps the clipboard for retry', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const parent = path.join(root, 'parent');
        const backup = path.join(root, 'old-parent');
        const replacement = path.join(root, 'replacement');
        const sourceRoot = path.join(parent, 'view');
        const source = path.join(sourceRoot, 'source.txt');
        const destination = path.join(root, 'source.txt');
        const retryRoot = path.join(root, 'retry');
        fs.mkdirSync(sourceRoot, { recursive: true });
        fs.mkdirSync(path.join(replacement, 'view'), { recursive: true });
        fs.mkdirSync(retryRoot);
        fs.writeFileSync(source, 'original');
        const sourceViewer = new DirectoryViewer({} as vscode.ExtensionContext, sourceRoot, 'test', {} as FileExtensionsManager);
        const originalCopy = fs.promises.copyFile;
        let notifyCopied!: () => void;
        let release!: () => void;
        const copied = new Promise<void>(resolve => { notifyCopied = resolve; });
        const waitForReplacement = new Promise<void>(resolve => { release = resolve; });
        fs.promises.copyFile = async (from, to, flags) => {
            await originalCopy(from, to, flags);
            if (from === source && to === destination) {
                notifyCopied();
                await waitForReplacement;
            }
        };
        try {
            sourceViewer.copy({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            const operation = viewer.paste(null);
            await copied;
            fs.renameSync(parent, backup);
            fs.symlinkSync(replacement, parent, 'dir');
            release();
            await operation;
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'original');
            fs.unlinkSync(parent);
            fs.renameSync(backup, parent);
            fs.promises.copyFile = originalCopy;
            await viewer.paste({ uri: vscode.Uri.file(retryRoot), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(path.join(retryRoot, 'source.txt'), 'utf8'), 'original');
        } finally {
            release();
            fs.promises.copyFile = originalCopy;
            sourceViewer.dispose();
        }
    });

    test('scratch creation rejects a root replaced while entering a name', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const parent = path.join(root, 'parent');
        const replacement = path.join(root, 'replacement');
        const viewRoot = path.join(parent, 'view');
        fs.mkdirSync(viewRoot, { recursive: true });
        fs.mkdirSync(path.join(replacement, 'view'), { recursive: true });
        const errors: string[] = [];
        const manager = { selectFileExtension: async () => '.txt', recordUsage: async () => undefined };
        const targetViewer = new DirectoryViewer({} as vscode.ExtensionContext, viewRoot, 'test', manager, testUI({
            input: async () => {
                fs.renameSync(parent, path.join(root, 'old-parent'));
                fs.symlinkSync(replacement, parent, 'dir');
                return 'new.txt';
            },
            error: message => { errors.push(message); },
        }));
        try {
            await targetViewer.newScratchFile();
            assert.deepStrictEqual(fs.readdirSync(path.join(replacement, 'view')), []);
            assert.ok(errors.some(message => message.includes('Scratch root changed')));
        } finally { targetViewer.dispose(); }
    });

    test('archive does not create a trash directory in a replaced root', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const parent = path.join(root, 'parent');
        const replacement = path.join(root, 'replacement');
        const archiveRoot = path.join(parent, 'view');
        fs.mkdirSync(archiveRoot, { recursive: true });
        fs.mkdirSync(path.join(replacement, 'view'), { recursive: true });
        const identity = fs.lstatSync(archiveRoot);
        fs.renameSync(parent, path.join(root, 'old-parent'));
        fs.symlinkSync(replacement, parent, 'dir');
        await assert.rejects(archiveFiles(archiveRoot, [], undefined, identity), /Scratch root changed/);
        assert.strictEqual(fs.existsSync(path.join(replacement, 'view', 'trash')), false);
    });

    test('archive reports conflicts and preserves both files', async () => {
        fs.mkdirSync(path.join(root, 'trash'));
        fs.writeFileSync(path.join(root, 'conflict.txt'), 'source');
        fs.writeFileSync(path.join(root, 'trash', 'conflict.txt'), 'existing');
        fs.writeFileSync(path.join(root, 'other.txt'), 'other');
        const result = await archiveFiles(root, ['conflict.txt', 'other.txt']);
        assert.deepStrictEqual(result, { moved: 1, failed: ['conflict.txt'] });
        assert.strictEqual(fs.readFileSync(path.join(root, 'conflict.txt'), 'utf8'), 'source');
        assert.strictEqual(fs.readFileSync(path.join(root, 'trash', 'conflict.txt'), 'utf8'), 'existing');
        assert.strictEqual(fs.readFileSync(path.join(root, 'trash', 'other.txt'), 'utf8'), 'other');
    });

    test('archive skips a file changed after the candidate list was prepared', async () => {
        const fileName = '20200101-000000.txt';
        const source = path.join(root, fileName);
        fs.writeFileSync(source, 'original');
        const snapshot = fs.statSync(source);
        fs.appendFileSync(source, ' updated');
        assert.deepStrictEqual(await archiveFiles(root, [fileName], new Map([[fileName, snapshot]])),
            { moved: 0, failed: [fileName] });
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'original updated');
        assert.strictEqual(fs.existsSync(path.join(root, 'trash', fileName)), false);
    });

    test('archive retains a file changed between candidate validation and moving', async () => {
        const fileName = '20200101-000000.txt';
        const source = path.join(root, fileName);
        fs.writeFileSync(source, 'original');
        const snapshot = fs.statSync(source);
        const originalLstat = fs.promises.lstat;
        let checks = 0;
        fs.promises.lstat = (async (...args: Parameters<typeof fs.promises.lstat>) => {
            if (args[0] === source && ++checks === 2) { fs.appendFileSync(source, ' updated'); }
            return originalLstat(...args);
        }) as typeof fs.promises.lstat;
        try {
            const result = await archiveFiles(root, [fileName], new Map([[fileName, snapshot]]));
            assert.deepStrictEqual(result, { moved: 0, failed: [fileName] });
            assert.strictEqual(fs.readFileSync(source, 'utf8'), 'original updated');
        } finally { fs.promises.lstat = originalLstat; }
    });

    test('cross-device move copies exclusively and removes the source', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination.txt');
        fs.writeFileSync(source, 'content');
        const operations = {
            lstat: fs.promises.lstat,
            link: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); },
            copyFile: fs.promises.copyFile,
            unlink: fs.promises.unlink,
        };
        await moveFileExclusive(source, destination, operations);
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'content');
        assert.strictEqual(fs.existsSync(source), false);
    });

    test('cross-device move retains the source and existing destination on conflict', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination.txt');
        fs.writeFileSync(source, 'source');
        fs.writeFileSync(destination, 'existing');
        const operations = {
            lstat: fs.promises.lstat,
            link: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); },
            copyFile: fs.promises.copyFile,
            unlink: fs.promises.unlink,
        };
        await assert.rejects(moveFileExclusive(source, destination, operations));
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'source');
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'existing');
    });

    test('move retains both files when source removal fails', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination.txt');
        fs.writeFileSync(source, 'content');
        const operations = {
            lstat: fs.promises.lstat,
            link: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); },
            copyFile: fs.promises.copyFile,
            unlink: async () => { throw new Error('access denied'); },
        };
        await assert.rejects(moveFileExclusive(source, destination, operations), /source could not be removed/);
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'content');
    });

    test('cross-device copy failure retains the source and reports a possible incomplete destination', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination.txt');
        fs.writeFileSync(source, 'source');
        const operations = {
            lstat: fs.promises.lstat,
            link: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); },
            copyFile: async () => { fs.writeFileSync(destination, 'partial'); throw new Error('disk full'); },
            unlink: fs.promises.unlink,
        };
        await assert.rejects(moveFileExclusive(source, destination, operations), /source was retained and destination may be incomplete/);
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'source');
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'partial');
    });

    test('move retains the source and destination when removal is no longer safe', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination.txt');
        fs.writeFileSync(source, 'content');
        await assert.rejects(moveFileExclusive(source, destination, fs.promises, () => {
            throw new Error('Unsaved document');
        }), /source was retained:.*Unsaved document/);
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'content');
    });

    for (const action of ['copy', 'cut'] as const) {
        test(`${action} reports a source view root change during transfer`, async () => {
            const source = path.join(root, 'source.txt');
            const destinationRoot = path.join(root, 'destination');
            const nextRoot = path.join(root, 'new-root');
            fs.mkdirSync(destinationRoot);
            fs.mkdirSync(nextRoot);
            fs.writeFileSync(source, 'content');
            const errors: string[] = [];
            const destinationViewer = new DirectoryViewer({} as vscode.ExtensionContext, destinationRoot, 'test', {} as FileExtensionsManager,
                testUI({ error: message => { errors.push(message); } }));
            const originalLink = fs.promises.link;
            const originalCopy = fs.promises.copyFile;
            fs.promises.link = async (from, to) => {
                await originalLink(from, to);
                if (from === source) { viewer.setRootPath(nextRoot); }
            };
            fs.promises.copyFile = async (from, to, mode) => {
                await originalCopy(from, to, mode);
                if (from === source) { viewer.setRootPath(nextRoot); }
            };
            try {
                viewer[action]({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
                await destinationViewer.paste(null);
                assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
                assert.strictEqual(fs.readFileSync(path.join(destinationRoot, 'source.txt'), 'utf8'), 'content');
                assert.ok(errors.some(message => message.includes('Source scratch directory changed')));
            } finally {
                fs.promises.link = originalLink;
                fs.promises.copyFile = originalCopy;
                destinationViewer.dispose();
            }
        });
    }

    test('cut keeps the source if the destination view changes while a move is in progress', async () => {
        const source = path.join(root, 'source.txt');
        const destinationRoot = path.join(root, 'destination');
        const nextRoot = path.join(root, 'new-root');
        fs.mkdirSync(destinationRoot);
        fs.mkdirSync(nextRoot);
        fs.writeFileSync(source, 'content');
        const destinationViewer = new DirectoryViewer({} as vscode.ExtensionContext, destinationRoot, 'test', {} as FileExtensionsManager);
        const originalLink = fs.promises.link;
        let notifyLinked!: () => void;
        let release!: () => void;
        const linked = new Promise<void>(resolve => { notifyLinked = resolve; });
        const waitForRootChange = new Promise<void>(resolve => { release = resolve; });
        fs.promises.link = async (existingPath, newPath) => {
            await originalLink(existingPath, newPath);
            if (existingPath === source && newPath === path.join(destinationRoot, 'source.txt')) {
                notifyLinked();
                await waitForRootChange;
            }
        };
        try {
            viewer.cut({ uri: vscode.Uri.file(source), type: vscode.FileType.File });
            const operation = destinationViewer.paste(null);
            await linked;
            destinationViewer.setRootPath(nextRoot);
            release();
            await operation;
            assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
            assert.strictEqual(fs.readFileSync(path.join(destinationRoot, 'source.txt'), 'utf8'), 'content');
            assert.deepStrictEqual(fs.readdirSync(nextRoot), []);
        } finally {
            release();
            fs.promises.link = originalLink;
            destinationViewer.dispose();
        }
    });

    test('move reports partial success if source disappears before it can be checked', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination.txt');
        fs.writeFileSync(source, 'content');
        let checks = 0;
        const operations = {
            ...fs.promises,
            lstat: (async (...args: Parameters<typeof fs.promises.lstat>) => {
                checks++;
                if (checks === 2) { throw new Error('source unavailable'); }
                return fs.promises.lstat(...args);
            }) as typeof fs.promises.lstat,
        };
        await assert.rejects(moveFileExclusive(source, destination, operations), /Destination created.*source could not be checked/);
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'content');
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'content');
    });

    test('move keeps both copies when the source changes after copying', async () => {
        const source = path.join(root, 'source.txt');
        const destination = path.join(root, 'destination.txt');
        fs.writeFileSync(source, 'initial');
        const operations = {
            lstat: fs.promises.lstat,
            link: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); },
            copyFile: async (from: fs.PathLike, to: fs.PathLike, mode?: number) => {
                await fs.promises.copyFile(from, to, mode);
                await fs.promises.appendFile(source, ' changed');
            },
            unlink: fs.promises.unlink,
        };
        await assert.rejects(moveFileExclusive(source, destination, operations), /Source changed/);
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'initial changed');
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'initial');
    });

    test('archive skips a file with unsaved editor changes', async () => {
        const file = vscode.Uri.file(path.join(root, '20200101-000000.txt'));
        fs.writeFileSync(file.fsPath, 'original');
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'changed '));
        try {
            assert.deepStrictEqual(await archiveFiles(root, [path.basename(file.fsPath)]),
                { moved: 0, failed: [path.basename(file.fsPath)] });
            assert.strictEqual(fs.readFileSync(file.fsPath, 'utf8'), 'original');
            assert.ok(document.isDirty);
        } finally {
            await vscode.commands.executeCommand('workbench.action.files.revert');
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('cut updates the open clean editor to the destination', async () => {
        const source = vscode.Uri.file(path.join(root, 'source.txt'));
        const destinationRoot = path.join(root, 'destination');
        const destination = path.join(destinationRoot, 'source.txt');
        fs.mkdirSync(destinationRoot);
        fs.writeFileSync(source.fsPath, 'content');
        const document = await vscode.workspace.openTextDocument(source);
        await vscode.window.showTextDocument(document, { preview: false });
        try {
            viewer.cut({ uri: source, type: vscode.FileType.File });
            await viewer.paste({ uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'content');
            assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
                tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === destination)));
        } finally { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); }
    });

    test('cut keeps both files and the original editor when the destination exists', async () => {
        const source = vscode.Uri.file(path.join(root, 'source.txt'));
        const destinationRoot = path.join(root, 'destination');
        const destination = path.join(destinationRoot, 'source.txt');
        fs.mkdirSync(destinationRoot);
        fs.writeFileSync(source.fsPath, 'source');
        fs.writeFileSync(destination, 'existing');
        const document = await vscode.workspace.openTextDocument(source);
        await vscode.window.showTextDocument(document, { preview: false });
        try {
            viewer.cut({ uri: source, type: vscode.FileType.File });
            await viewer.paste({ uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(source.fsPath, 'utf8'), 'source');
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'existing');
            assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
                tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === source.fsPath)));
        } finally { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); }
    });

    test('cut retains the source if it is opened while moving', async () => {
        const source = vscode.Uri.file(path.join(root, 'source.txt'));
        const destinationRoot = path.join(root, 'destination');
        const destination = path.join(destinationRoot, 'source.txt');
        fs.mkdirSync(destinationRoot);
        fs.writeFileSync(source.fsPath, 'content');
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        const originalLink = fs.promises.link;
        let notifyLinked!: () => void;
        let release!: () => void;
        const linked = new Promise<void>(resolve => { notifyLinked = resolve; });
        const waitForOpen = new Promise<void>(resolve => { release = resolve; });
        fs.promises.link = async (existingPath, newPath) => {
            await originalLink(existingPath, newPath);
            if (existingPath === source.fsPath && newPath === destination) {
                notifyLinked();
                await waitForOpen;
            }
        };
        try {
            viewer.cut({ uri: source, type: vscode.FileType.File });
            const operation = target.paste({ uri: vscode.Uri.file(destinationRoot), type: vscode.FileType.Directory });
            await linked;
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), { preview: false });
            release();
            await operation;
            assert.strictEqual(fs.readFileSync(source.fsPath, 'utf8'), 'content');
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'content');
            assert.ok(errors.some(message => message.includes('File was opened during the move')));
        } finally {
            release();
            fs.promises.link = originalLink;
            target.dispose();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('archive updates the open clean editor to the trash path', async () => {
        const name = '20200101-000000.txt';
        const source = vscode.Uri.file(path.join(root, name));
        const destination = path.join(root, 'trash', name);
        fs.writeFileSync(source.fsPath, 'content');
        const document = await vscode.workspace.openTextDocument(source);
        await vscode.window.showTextDocument(document, { preview: false });
        try {
            assert.deepStrictEqual(await archiveFiles(root, [name]), { moved: 1, failed: [] });
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'content');
            assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
                tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === destination)));
        } finally { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); }
    });

    test('cut does not move a file with unsaved editor changes', async () => {
        const file = vscode.Uri.file(path.join(root, 'source.txt'));
        const destination = path.join(root, 'destination');
        fs.mkdirSync(destination);
        fs.writeFileSync(file.fsPath, 'original');
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'changed '));
        try {
            viewer.cut({ uri: file, type: vscode.FileType.File });
            await viewer.paste({ uri: vscode.Uri.file(destination), type: vscode.FileType.Directory });
            assert.strictEqual(fs.readFileSync(file.fsPath, 'utf8'), 'original');
            assert.strictEqual(fs.existsSync(path.join(destination, 'source.txt')), false);
            assert.ok(document.isDirty);
        } finally {
            await vscode.commands.executeCommand('workbench.action.files.revert');
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('comparison is available only for exactly two distinct selected files', () => {
        const first = { uri: vscode.Uri.file(path.join(root, 'first.txt')), type: vscode.FileType.File };
        const second = { uri: vscode.Uri.file(path.join(root, 'second.txt')), type: vscode.FileType.File };
        const folder = { uri: vscode.Uri.file(path.join(root, 'folder')), type: vscode.FileType.Directory };
        assert.strictEqual(canCompareSelection([]), false);
        assert.strictEqual(canCompareSelection([first]), false);
        assert.strictEqual(canCompareSelection([first, first]), false);
        assert.strictEqual(canCompareSelection([first, folder]), false);
        assert.strictEqual(canCompareSelection([first, second, folder]), false);
        assert.strictEqual(canCompareSelection([first, second]), true);
        viewer.updateSelection([first, second]);
        assert.strictEqual(viewer.selectedItems.length, 2);
        viewer.setRootPath(root);
        assert.deepStrictEqual(viewer.selectedItems, []);
    });

    test('compares files from different views and swaps the diff sides', async () => {
        const first = vscode.Uri.file(path.join(root, 'first.txt'));
        const secondRoot = path.join(root, 'other');
        fs.mkdirSync(secondRoot);
        const second = vscode.Uri.file(path.join(secondRoot, 'second.txt'));
        fs.writeFileSync(first.fsPath, 'old');
        fs.writeFileSync(second.fsPath, 'new');
        const errors: string[] = [];
        const left = new DirectoryViewer({} as vscode.ExtensionContext, root, 'left', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        const right = new DirectoryViewer({} as vscode.ExtensionContext, secondRoot, 'right', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        try {
            await left.selectForCompare({ uri: first, type: vscode.FileType.File });
            await right.compareWithSelected({ uri: second, type: vscode.FileType.File });
            let input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            assert.ok(input instanceof vscode.TabInputTextDiff);
            assert.strictEqual(input.original.fsPath, first.fsPath);
            assert.strictEqual(input.modified.fsPath, second.fsPath);
            await Scratches.swapComparison();
            input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            assert.ok(input instanceof vscode.TabInputTextDiff);
            assert.strictEqual(input.original.fsPath, second.fsPath);
            assert.strictEqual(input.modified.fsPath, first.fsPath);
            assert.deepStrictEqual(errors, []);
        } finally {
            left.dispose(); right.dispose();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('compares exactly two selected text files using their open unsaved contents', async () => {
        const first = vscode.Uri.file(path.join(root, 'first.txt'));
        const second = vscode.Uri.file(path.join(root, 'second.txt'));
        fs.writeFileSync(first.fsPath, 'old');
        fs.writeFileSync(second.fsPath, 'saved');
        const document = await vscode.workspace.openTextDocument(second);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'unsaved '));
        try {
            const items = [{ uri: first, type: vscode.FileType.File }, { uri: second, type: vscode.FileType.File }];
            await viewer.compareSelected(items[0], items);
            const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            assert.ok(input instanceof vscode.TabInputTextDiff);
            assert.strictEqual(input.original.fsPath, first.fsPath);
            assert.strictEqual(input.modified.fsPath, second.fsPath);
            assert.strictEqual(document.getText(), 'unsaved saved');
            assert.strictEqual(document.isDirty, true);
        } finally {
            await vscode.window.showTextDocument(document);
            await vscode.commands.executeCommand('workbench.action.files.revert');
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('compares unsaved scratch contents with editable clipboard text', async () => {
        const uri = vscode.Uri.file(path.join(root, 'clipboard.txt'));
        fs.writeFileSync(uri.fsPath, 'saved');
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ readText: async () => 'clipboard text', error: message => { errors.push(message); } }));
        const source = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(source);
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'unsaved '));
        let temporary: vscode.TextDocument | undefined;
        try {
            await target.compareWithClipboard({ uri, type: vscode.FileType.File });
            const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            assert.ok(input instanceof vscode.TabInputTextDiff);
            assert.strictEqual(input.original.toString(), uri.toString());
            assert.strictEqual(input.modified.scheme, 'untitled');
            temporary = await vscode.workspace.openTextDocument(input.modified);
            assert.strictEqual(temporary.getText(), 'clipboard text');
            assert.strictEqual(temporary.languageId, source.languageId);
            assert.strictEqual(source.getText(), 'unsaved saved');
            const tempEditor = await vscode.window.showTextDocument(temporary);
            await tempEditor.edit(builder => builder.insert(new vscode.Position(0, 0), 'edited '));
            assert.strictEqual(temporary.getText(), 'edited clipboard text');
            assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), 'saved');
            assert.deepStrictEqual(errors, []);
        } finally {
            if (temporary) { await vscode.window.showTextDocument(temporary); await vscode.commands.executeCommand('workbench.action.files.revert'); }
            await vscode.window.showTextDocument(source);
            await vscode.commands.executeCommand('workbench.action.files.revert');
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            target.dispose();
        }
    });

    test('rejects oversized clipboard and root changes while reading it', async () => {
        const uri = vscode.Uri.file(path.join(root, 'clipboard.txt'));
        fs.writeFileSync(uri.fsPath, 'text');
        const errors: string[] = [];
        let release: (value: string) => void = () => undefined;
        let started: () => void = () => undefined;
        const reading = new Promise<void>(resolve => { started = resolve; });
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ readText: () => { started(); return new Promise(resolve => { release = resolve; }); }, error: message => { errors.push(message); } }));
        try {
            const item = { uri, type: vscode.FileType.File };
            let pending = target.compareWithClipboard(item);
            await reading;
            release('x'.repeat(10 * 1024 * 1024 + 1));
            await pending;
            assert.ok(errors.some(message => message.includes('10 MiB')));
            const readingAgain = new Promise<void>(resolve => { started = resolve; });
            pending = target.compareWithClipboard(item);
            await readingAgain;
            target.setRootPath(root);
            release('text');
            await pending;
            assert.ok(errors.some(message => message.includes('directory changed')));
        } finally { target.dispose(); }
    });

    test('comparison rejects binary files, an invalid selection and a replaced source', async () => {
        const first = vscode.Uri.file(path.join(root, 'first.txt'));
        const binary = vscode.Uri.file(path.join(root, 'binary.bin'));
        fs.writeFileSync(first.fsPath, 'text');
        fs.writeFileSync(binary.fsPath, Buffer.from([0, 1, 2]));
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        try {
            const item = { uri: first, type: vscode.FileType.File };
            await target.compareSelected(item, [item]);
            await target.selectForCompare({ uri: binary, type: vscode.FileType.File });
            await target.selectForCompare(item);
            fs.renameSync(first.fsPath, path.join(root, 'original.txt'));
            fs.writeFileSync(first.fsPath, 'replacement');
            const other = vscode.Uri.file(path.join(root, 'second.txt'));
            fs.writeFileSync(other.fsPath, 'other');
            await target.compareWithSelected({ uri: other, type: vscode.FileType.File });
            assert.ok(errors.some(message => message.includes('exactly two')));
            assert.ok(errors.some(message => message.includes('UTF-8 text')));
            assert.ok(errors.some(message => message.includes('replaced')));
        } finally { target.dispose(); }
    });

    test('comparison rejects files larger than the limit and a changed source root', async () => {
        const first = vscode.Uri.file(path.join(root, 'first.txt'));
        const second = vscode.Uri.file(path.join(root, 'second.txt'));
        const nextRoot = path.join(root, 'next');
        fs.writeFileSync(first.fsPath, 'first');
        fs.writeFileSync(second.fsPath, 'second');
        fs.mkdirSync(nextRoot);
        const large = path.join(root, 'large.txt');
        const handle = fs.openSync(large, 'w');
        fs.ftruncateSync(handle, 10 * 1024 * 1024 + 1);
        fs.closeSync(handle);
        const errors: string[] = [];
        const source = new DirectoryViewer({} as vscode.ExtensionContext, root, 'source', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'target', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        try {
            await source.selectForCompare({ uri: vscode.Uri.file(large), type: vscode.FileType.File });
            await source.selectForCompare({ uri: first, type: vscode.FileType.File });
            source.setRootPath(nextRoot);
            await target.compareWithSelected({ uri: second, type: vscode.FileType.File });
            assert.ok(errors.some(message => message.includes('10 MiB')));
            assert.ok(errors.some(message => message.includes('Select a first file')));
        } finally { source.dispose(); target.dispose(); }
    });

    test('comparison clears the first selection when its file disappears', async () => {
        const first = vscode.Uri.file(path.join(root, 'first.txt'));
        const second = vscode.Uri.file(path.join(root, 'second.txt'));
        fs.writeFileSync(first.fsPath, 'first');
        fs.writeFileSync(second.fsPath, 'second');
        const errors: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ error: message => { errors.push(message); } }));
        try {
            await target.selectForCompare({ uri: first, type: vscode.FileType.File });
            fs.unlinkSync(first.fsPath);
            const item = { uri: second, type: vscode.FileType.File };
            target.updateSelection([item]);
            await target.compareWithSelected(item);
            assert.ok(errors.some(message => message.includes('Select a first file')));
        } finally { target.dispose(); }
    });

    test('rename proposes the current file or folder name and accepts it unchanged', async () => {
        for (const type of [vscode.FileType.File, vscode.FileType.Directory]) {
            const name = type === vscode.FileType.File ? 'example.test.json' : 'example-folder';
            const itemPath = path.join(root, name);
            if (type === vscode.FileType.File) { fs.writeFileSync(itemPath, 'content'); }
            else { fs.mkdirSync(itemPath); }
            let proposed: string | undefined;
            const errors: string[] = [];
            const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
                testUI({ input: async options => { proposed = options.value; return options.value; },
                    error: message => { errors.push(message); } }));
            try {
                await target.rename({ uri: vscode.Uri.file(itemPath), type });
                assert.strictEqual(proposed, name);
                assert.strictEqual(fs.existsSync(itemPath), true);
                assert.deepStrictEqual(errors, []);
            } finally { target.dispose(); }
        }
    });

    for (const operation of ['rename', 'delete'] as const) {
        test(`${operation} refuses a file replaced while waiting for user input`, async () => {
            const file = path.join(root, 'selected.txt');
            const backup = path.join(root, 'original.txt');
            fs.writeFileSync(file, 'original');
            const errors: string[] = [];
            const replace = () => { fs.renameSync(file, backup); fs.writeFileSync(file, 'replacement'); };
            const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
                testUI({ input: async () => { replace(); return 'renamed.txt'; },
                    confirm: async () => { replace(); return 'Yes'; }, error: message => { errors.push(message); } }));
            try {
                await controlledViewer[operation]({ uri: vscode.Uri.file(file), type: vscode.FileType.File });
                assert.strictEqual(fs.readFileSync(file, 'utf8'), 'replacement');
                assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'original');
                assert.strictEqual(fs.existsSync(path.join(root, 'renamed.txt')), false);
                assert.ok(errors.some(message => message.includes('Selected item was replaced')));
            } finally { controlledViewer.dispose(); }
        });
    }

    test('batch deletion confirms once and avoids deleting nested selections twice', async () => {
        const folder = path.join(root, 'folder');
        const child = path.join(folder, 'child.txt');
        const file = path.join(root, 'other.txt');
        fs.mkdirSync(folder);
        fs.writeFileSync(child, 'child');
        fs.writeFileSync(file, 'other');
        let confirmations = 0;
        const removed: string[] = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ confirm: async () => { confirmations++; return 'Yes'; }, deleteItem: async (uri, options) => {
                assert.strictEqual(options.useTrash, true);
                removed.push(uri.fsPath);
                fs.rmSync(uri.fsPath, { recursive: options.recursive });
            } }));
        target.selectedItems = [
            { uri: vscode.Uri.file(folder), type: vscode.FileType.Directory },
            { uri: vscode.Uri.file(child), type: vscode.FileType.File },
            { uri: vscode.Uri.file(file), type: vscode.FileType.File },
        ];
        try {
            await target.delete(null);
            assert.strictEqual(confirmations, 1);
            assert.deepStrictEqual(removed, [folder, file]);
            assert.strictEqual(fs.existsSync(folder), false);
            assert.strictEqual(fs.existsSync(file), false);
        } finally { target.dispose(); }
    });

    test('delete uses the selected file and requests the system trash after confirmation', async () => {
        const file = path.join(root, 'selected.txt');
        fs.writeFileSync(file, 'content');
        const calls: Array<{ uri: vscode.Uri; recursive: boolean; useTrash: boolean }> = [];
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ confirm: async () => 'Yes', deleteItem: async (uri, options) => {
                calls.push({ uri, ...options });
                fs.unlinkSync(uri.fsPath);
            } }));
        target.selectItem = { uri: vscode.Uri.file(file), type: vscode.FileType.File };
        try {
            await target.delete(null);
            assert.deepStrictEqual(calls.map(call => ({ path: call.uri.fsPath, recursive: call.recursive, useTrash: call.useTrash })),
                [{ path: file, recursive: false, useTrash: true }]);
            assert.strictEqual(fs.existsSync(file), false);
            assert.strictEqual(target.selectItem, null);
        } finally { target.dispose(); }
    });

    test('delete cancels without touching the selected file', async () => {
        const file = path.join(root, 'selected.txt');
        fs.writeFileSync(file, 'content');
        let called = false;
        const target = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ confirm: async () => 'No', deleteItem: async () => { called = true; } }));
        target.selectItem = { uri: vscode.Uri.file(file), type: vscode.FileType.File };
        try {
            await target.delete(null);
            assert.strictEqual(called, false);
            assert.strictEqual(fs.readFileSync(file, 'utf8'), 'content');
        } finally { target.dispose(); }
    });

    test('delete shortcuts use the standard macOS backspace key in each view', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
            contributes: { keybindings: Array<{ command: string; key: string; mac?: string; when?: string }> };
        };
        for (const view of ['sectionProjectFiles', 'sectionSharedFiles', 'sectionAllFiles']) {
            const binding = manifest.contributes.keybindings.find(item => item.command === `${view}.delete`);
            assert.ok(binding);
            assert.strictEqual(binding.mac, 'cmd+backspace');
            assert.strictEqual(binding.when, `focusedView == ${view}`);
        }
    });

    test('delete refuses a file with unsaved changes after confirmation', async () => {
        const file = vscode.Uri.file(path.join(root, 'source.txt'));
        fs.writeFileSync(file.fsPath, 'original');
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'changed '));
        const errors: string[] = [];
        const controlledViewer = new DirectoryViewer({} as vscode.ExtensionContext, root, 'test', {} as FileExtensionsManager,
            testUI({ confirm: async () => 'Yes', error: message => { errors.push(message); } }));
        try {
            await controlledViewer.delete({ uri: file, type: vscode.FileType.File });
            assert.strictEqual(fs.readFileSync(file.fsPath, 'utf8'), 'original');
            assert.ok(document.isDirty);
            assert.ok(errors.some(message => message.includes('Save unsaved documents')));
        } finally {
            controlledViewer.dispose();
            await vscode.commands.executeCommand('workbench.action.files.revert');
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('moves a file across real filesystems when a test volume is provided', async function () {
        const volume = process.env.SCRATCHES_TEST_CROSS_DEVICE_DIR;
        if (!volume) { this.skip(); }
        const destinationRoot = fs.mkdtempSync(path.join(volume, 'scratches-cross-'));
        try {
            assert.notStrictEqual(fs.statSync(root).dev, fs.statSync(destinationRoot).dev);
            const source = path.join(root, 'source.txt');
            const destination = path.join(destinationRoot, 'destination.txt');
            fs.writeFileSync(source, 'cross-device');
            await moveFileExclusive(source, destination);
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'cross-device');
            assert.strictEqual(fs.existsSync(source), false);
        } finally {
            fs.rmSync(destinationRoot, { recursive: true, force: true });
        }
    });

    test('VS Code can move an open clean file across real filesystems', async function () {
        const volume = process.env.SCRATCHES_TEST_CROSS_DEVICE_DIR;
        if (!volume) { this.skip(); }
        const destinationRoot = fs.mkdtempSync(path.join(volume, 'scratches-editor-cross-'));
        const source = vscode.Uri.file(path.join(root, 'editor-cross.txt'));
        const destination = vscode.Uri.file(path.join(destinationRoot, 'editor-cross.txt'));
        fs.writeFileSync(source.fsPath, 'content');
        const document = await vscode.workspace.openTextDocument(source);
        await vscode.window.showTextDocument(document, { preview: false });
        try {
            assert.notStrictEqual(fs.statSync(root).dev, fs.statSync(destinationRoot).dev);
            await renameInEditor(source, destination);
            assert.strictEqual(fs.readFileSync(destination.fsPath, 'utf8'), 'content');
            assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
                tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === destination.fsPath)));
        } finally {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            fs.rmSync(destinationRoot, { recursive: true, force: true });
        }
    });

    test('cut updates an open editor when moving across real filesystems', async function () {
        const volume = process.env.SCRATCHES_TEST_CROSS_DEVICE_DIR;
        if (!volume) { this.skip(); }
        const destinationRoot = fs.mkdtempSync(path.join(volume, 'scratches-cut-cross-'));
        const source = vscode.Uri.file(path.join(root, 'cut-cross.txt'));
        const destination = path.join(destinationRoot, 'cut-cross.txt');
        const target = new DirectoryViewer({} as vscode.ExtensionContext, destinationRoot, 'test', {} as FileExtensionsManager);
        fs.writeFileSync(source.fsPath, 'content');
        const document = await vscode.workspace.openTextDocument(source);
        await vscode.window.showTextDocument(document, { preview: false });
        try {
            assert.notStrictEqual(fs.statSync(root).dev, fs.statSync(destinationRoot).dev);
            viewer.cut({ uri: source, type: vscode.FileType.File });
            await target.paste(null);
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'content');
            assert.strictEqual(fs.existsSync(source.fsPath), false);
            assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
                tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === destination)));
        } finally {
            target.dispose();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            fs.rmSync(destinationRoot, { recursive: true, force: true });
        }
    });

    test('projects with the same folder name have separate storage paths', () => {
        const first = getProjectStoragePath(root, vscode.Uri.file('/one/project'));
        const second = getProjectStoragePath(root, vscode.Uri.file('/two/project'));
        assert.notStrictEqual(first, second);
        assert.strictEqual(first, getProjectStoragePath(root, vscode.Uri.file('/one/project')));
    });

    test('switching projects creates a new root before updating the existing view', () => {
        const first = ensureProjectStoragePath(root, vscode.Uri.file(path.join(root, 'workspace-one')));
        const secondUri = vscode.Uri.file(path.join(root, 'workspace-two'));
        const second = getProjectStoragePath(root, secondUri);
        const projectViewer = new DirectoryViewer({} as vscode.ExtensionContext, first, 'test', {} as FileExtensionsManager);
        try {
            assert.strictEqual(fs.existsSync(second), false);
            projectViewer.setRootPath(ensureProjectStoragePath(root, secondUri));
            assert.strictEqual(projectViewer.rootPath, second);
            assert.ok(fs.statSync(second).isDirectory());
            assert.ok(fs.statSync(first).isDirectory());
        } finally { projectViewer.dispose(); }
    });

    test('project storage creation rejects an existing file without overwriting it', () => {
        const project = vscode.Uri.file(path.join(root, 'workspace'));
        const projectPath = getProjectStoragePath(root, project);
        fs.mkdirSync(path.dirname(projectPath));
        fs.writeFileSync(projectPath, 'original');
        assert.throws(() => ensureProjectStoragePath(root, project));
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), 'original');
    });

    test('renaming refuses unsaved changes and preserves the open editor after saving', async () => {
        const source = vscode.Uri.file(path.join(root, 'original.txt'));
        const destination = vscode.Uri.file(path.join(root, 'renamed.txt'));
        fs.writeFileSync(source.fsPath, 'original');
        const document = await vscode.workspace.openTextDocument(source);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'changed '));
        try {
            await assert.rejects(renameInEditor(source, destination), /Save unsaved/);
            assert.strictEqual(fs.readFileSync(source.fsPath, 'utf8'), 'original');
            assert.ok(document.isDirty);
            assert.strictEqual(await document.save(), true);
            await renameInEditor(source, destination);
            assert.strictEqual(fs.readFileSync(destination.fsPath, 'utf8'), 'changed original');
            assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
                tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === destination.fsPath)));
        } finally {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('renaming does not overwrite a destination', async () => {
        const source = vscode.Uri.file(path.join(root, 'source.txt'));
        const destination = vscode.Uri.file(path.join(root, 'existing.txt'));
        fs.writeFileSync(source.fsPath, 'source');
        fs.writeFileSync(destination.fsPath, 'existing');
        await assert.rejects(renameInEditor(source, destination));
        assert.strictEqual(fs.readFileSync(source.fsPath, 'utf8'), 'source');
        assert.strictEqual(fs.readFileSync(destination.fsPath, 'utf8'), 'existing');
    });

    test('renaming a folder refuses unsaved documents inside it', async () => {
        const folder = vscode.Uri.file(path.join(root, 'folder'));
        const target = vscode.Uri.file(path.join(root, 'renamed'));
        fs.mkdirSync(folder.fsPath);
        const file = vscode.Uri.file(path.join(folder.fsPath, 'nested.txt'));
        fs.writeFileSync(file.fsPath, 'original');
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'changed '));
        try {
            await assert.rejects(renameInEditor(folder, target), /Save unsaved/);
            assert.strictEqual(fs.readFileSync(file.fsPath, 'utf8'), 'original');
            assert.ok(document.isDirty);
        } finally {
            await vscode.commands.executeCommand('workbench.action.files.revert');
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });
});

suite('Extension lifecycle', () => {
    test('refreshes trees after external changes below a scratch root outside the workspace', async function () {
        this.timeout(15000);
        const root = fs.mkdtempSync(path.join(process.env.SCRATCHES_TEST_TMPDIR || os.tmpdir(), 'scratches-watch-'));
        const nested = path.join(root, 'nested');
        const file = path.join(nested, 'external.txt');
        const hiddenFolder = path.join(root, '.hidden');
        const hiddenFile = path.join(hiddenFolder, 'external.txt');
        fs.mkdirSync(nested);
        fs.mkdirSync(hiddenFolder);
        const config = vscode.workspace.getConfiguration('scratches');
        const extension = vscode.extensions.getExtension('scratches.scratches');
        assert.ok(extension);
        try {
            await extension.activate();
            await config.update('path', root, vscode.ConfigurationTarget.Global);
            const views = (Scratches as unknown as { viewers: Map<string, DirectoryViewer> }).viewers;
            const all = views.get('sectionAllFiles');
            const shared = views.get('sectionSharedFiles');
            assert.ok(all && shared);
            let sharedRefreshes = 0;
            const sharedSubscription = shared.onDidChangeTreeData(() => { sharedRefreshes++; });
            const waitForRefresh = (write: () => void) => new Promise<void>((resolve, reject) => {
                const subscription = all.onDidChangeTreeData(() => { cleanup(); resolve(); });
                const interval = setInterval(write, 150);
                const timeout = setTimeout(() => { cleanup(); reject(new Error('File watcher did not refresh')); }, 6000);
                function cleanup() { subscription.dispose(); clearInterval(interval); clearTimeout(timeout); }
                write();
            });
            try {
                await waitForRefresh(() => { fs.writeFileSync(file, 'content'); });
                assert.ok(sharedRefreshes > 0);
                const items = await all.getChildren({ uri: vscode.Uri.file(nested), type: vscode.FileType.Directory });
                assert.ok(items.some(item => item.uri.fsPath === file));
                await waitForRefresh(() => { if (fs.existsSync(file)) { fs.unlinkSync(file); } });
                assert.deepStrictEqual(await all.getChildren({ uri: vscode.Uri.file(nested), type: vscode.FileType.Directory }), []);
                await new Promise<void>(resolve => setTimeout(resolve, 400));
                await waitForRefresh(() => { fs.writeFileSync(hiddenFile, 'content'); });
                const hiddenItems = await all.getChildren({ uri: vscode.Uri.file(hiddenFolder), type: vscode.FileType.Directory });
                assert.ok(hiddenItems.some(item => item.uri.fsPath === hiddenFile));
            } finally { sharedSubscription.dispose(); }
        } finally {
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('registers the welcome view when no scratch directory is configured', async () => {
        const config = vscode.workspace.getConfiguration('scratches');
        const extension = vscode.extensions.getExtension('scratches.scratches');
        assert.ok(extension);
        await config.update('path', undefined, vscode.ConfigurationTarget.Global);
        await extension.activate();
        await vscode.commands.executeCommand('viewsWelcome.focus');
        assert.ok((await vscode.commands.getCommands(true)).includes('scratches.setRootPath'));
    });

    test('project creation is unavailable without a workspace folder', async function () {
        if (vscode.workspace.workspaceFolders?.length) { this.skip(); }
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-no-project-'));
        const config = vscode.workspace.getConfiguration('scratches');
        const extension = vscode.extensions.getExtension('scratches.scratches');
        assert.ok(extension);
        try {
            await extension.activate();
            await config.update('path', root, vscode.ConfigurationTarget.Global);
            const views = (Scratches as unknown as { viewers: Map<string, DirectoryViewer> }).viewers;
            assert.strictEqual(views.get('sectionProjectFiles')?.rootPath, '');
            await vscode.commands.executeCommand('sectionProjectFiles.newScratchFile');
            assert.deepStrictEqual(fs.readdirSync(root), ['share']);
            const saved = ensureProjectStoragePath(root, vscode.Uri.file(path.join(root, 'closed-project')));
            fs.writeFileSync(path.join(saved, 'old.txt'), 'old');
            const state = new Map<string, unknown>();
            const context = { workspaceState: {
                get: (key: string) => state.get(key),
                update: async (key: string, value: unknown) => { state.set(key, value); },
            } } as unknown as vscode.ExtensionContext;
            await Scratches.selectWorkspaceFolder(context, async choices => {
                const choice = choices.find(item => item.kind === 'saved' && item.name === path.basename(saved));
                assert.ok(choice);
                return choice;
            });
            assert.strictEqual(views.get('sectionProjectFiles')?.rootPath, saved);
            assert.strictEqual(fs.readFileSync(path.join(saved, 'old.txt'), 'utf8'), 'old');
        } finally {
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('invalid roots do not prevent recovery with a valid root', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-root-recovery-'));
        const invalidFile = path.join(root, 'not-a-directory');
        fs.writeFileSync(invalidFile, 'original');
        const config = vscode.workspace.getConfiguration('scratches');
        const extension = vscode.extensions.getExtension('scratches.scratches');
        assert.ok(extension);
        try {
            await extension.activate();
            await config.update('path', invalidFile, vscode.ConfigurationTarget.Global);
            assert.ok((await vscode.commands.getCommands(true)).includes('scratches.setRootPath'));
            assert.strictEqual(fs.readFileSync(invalidFile, 'utf8'), 'original');
            await config.update('path', path.join(root, 'missing'), vscode.ConfigurationTarget.Global);
            assert.ok((await vscode.commands.getCommands(true)).includes('scratches.setRootPath'));
            await config.update('path', root, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('sectionSharedFiles.refresh');
            assert.ok(fs.statSync(path.join(root, 'share')).isDirectory());
        } finally {
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a symbolic-link root is rejected without modifying its target', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-link-root-'));
        const target = path.join(root, 'target');
        const link = path.join(root, 'link');
        fs.mkdirSync(target);
        fs.symlinkSync(target, link, 'dir');
        const config = vscode.workspace.getConfiguration('scratches');
        try {
            await config.update('path', link, vscode.ConfigurationTarget.Global);
            assert.deepStrictEqual(fs.readdirSync(target), []);
            assert.ok((await vscode.commands.getCommands(true)).includes('scratches.setRootPath'));
        } finally {
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('an inaccessible root can be recovered after permissions are restored', async function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); }
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-no-access-'));
        const config = vscode.workspace.getConfiguration('scratches');
        try {
            fs.chmodSync(root, 0);
            assert.throws(() => fs.accessSync(root, fs.constants.R_OK));
            await config.update('path', root, vscode.ConfigurationTarget.Global);
            assert.ok((await vscode.commands.getCommands(true)).includes('scratches.setRootPath'));
            fs.chmodSync(root, 0o700);
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            await config.update('path', root, vscode.ConfigurationTarget.Global);
            assert.ok(fs.statSync(path.join(root, 'share')).isDirectory());
        } finally {
            fs.chmodSync(root, 0o700);
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('moving between views refreshes both source and destination', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-views-'));
        const config = vscode.workspace.getConfiguration('scratches');
        try {
            await config.update('path', root, vscode.ConfigurationTarget.Global);
            const views = (Scratches as unknown as { viewers: Map<string, DirectoryViewer> }).viewers;
            const shared = views.get('sectionSharedFiles');
            const all = views.get('sectionAllFiles');
            assert.ok(shared);
            assert.ok(all);
            const file = path.join(root, 'share', 'source.txt');
            fs.writeFileSync(file, 'content');
            let sharedUpdates = 0;
            let allUpdates = 0;
            const subscriptions = [shared.onDidChangeTreeData(() => { sharedUpdates++; }), all.onDidChangeTreeData(() => { allUpdates++; })];
            try {
                shared.cut({ uri: vscode.Uri.file(file), type: vscode.FileType.File });
                await all.paste(null);
                assert.strictEqual(fs.existsSync(file), false);
                assert.strictEqual(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'content');
                assert.ok(sharedUpdates > 0);
                assert.ok(allUpdates > 0);
            } finally { subscriptions.forEach(subscription => subscription.dispose()); }
        } finally {
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('changing and clearing the root replaces command registrations', async () => {
        const first = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-first-'));
        const second = fs.mkdtempSync(path.join(os.tmpdir(), 'scratches-second-'));
        const config = vscode.workspace.getConfiguration('scratches');
        const extension = vscode.extensions.getExtension('scratches.scratches');
        assert.ok(extension);
        try {
            await extension.activate();
            await config.update('path', first, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('sectionSharedFiles.refresh');
            await config.update('path', second, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('sectionSharedFiles.refresh');
            assert.ok(fs.existsSync(path.join(first, 'share')));
            assert.ok(fs.existsSync(path.join(second, 'share')));
        } finally {
            await config.update('path', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(first, { recursive: true, force: true });
            fs.rmSync(second, { recursive: true, force: true });
        }
    });
});
