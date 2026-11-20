
import * as path from "path";
import * as vscode from 'vscode';
import * as directory from './directory';
import * as fs from "fs";
import * as fileExtension from "./file_extension";
import { macOSFileClipboard } from './macos_file_clipboard';
import { searchTextFiles } from './content_search';
import { MAX_COMPARE_BYTES, validateTextFile } from './compare_files';
import { RootWatcher } from './root_watcher';

let scratchesDirectory: string;
let copiedFileUri: vscode.Uri | null;
let copiedFileRoot: string | null = null;
let copiedRootIdentity: RootIdentity | undefined;
let copiedFileIdentity: FileIdentity | undefined;
let copiedSourceIsActive: (() => boolean) | undefined;
let actionWithFile: ActionFile | null = null;
let nativeSelection: { identity: FileIdentity; changeCount: number } | undefined;
let nativeFailureIdentity: FileIdentity | undefined;
let nativeOperation: Promise<void> = Promise.resolve();
let copiedBatch: { entries: Array<{ uri: vscode.Uri; identity: FileIdentity; type: vscode.FileType }>; root: string;
    rootIdentity: RootIdentity | undefined; isActive: () => boolean; action: ActionFile; token: FileIdentity } | undefined;
const scratchTreeIds = ['sectionProjectFiles', 'sectionSharedFiles', 'sectionAllFiles'];
const treeMime = (id: string) => `application/vnd.code.tree.${id.toLowerCase()}`;
let activeDrag: { sourceView: string; batch: NonNullable<typeof copiedBatch> } | undefined;

export interface FileClipboard {
    read(): Promise<{ paths: string[]; changeCount: number }>;
    write(paths: string[]): Promise<{ changeCount: number }>;
}

export function canCompareSelection(items: readonly FileItem[]): boolean {
    return items.length === 2 && items.every(item => item.type === vscode.FileType.File) &&
        items[0].uri.toString() !== items[1].uri.toString();
}

const systemFileClipboard: FileClipboard | undefined = process.platform === 'darwin' &&
    vscode.env.uiKind === vscode.UIKind.Desktop && !vscode.env.remoteName ? {
        read: async () => { const value = await macOSFileClipboard('read', [], process.env.SCRATCHES_TEST_FILE_PASTEBOARD); return { paths: value.paths ?? [], changeCount: value.changeCount }; },
        write: async paths => macOSFileClipboard('write', paths, process.env.SCRATCHES_TEST_FILE_PASTEBOARD),
    } : undefined;

function validName(name: string): boolean {
    return name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

function hasDirtyDocument(target: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some(document => {
        if (!document.isDirty || document.uri.scheme !== 'file') { return false; }
        const relative = path.relative(target.fsPath, document.uri.fsPath);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
}

function hasOpenDocument(target: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some(document => document.uri.toString() === target.toString());
}

export async function renameInEditor(source: vscode.Uri, destination: vscode.Uri): Promise<void> {
    if (hasDirtyDocument(source)) { throw new Error('Save unsaved documents before renaming'); }
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(source, destination, { overwrite: false, ignoreIfExists: false });
    if (!await vscode.workspace.applyEdit(edit)) { throw new Error('VS Code could not rename the item'); }
}

type FileIdentity = Pick<fs.Stats, 'dev' | 'ino'>;
type RootIdentity = FileIdentity;
type ProjectChoice = { kind: 'workspace'; folder: vscode.WorkspaceFolder } | { kind: 'saved'; name: string };
type CompareItem = { uri: vscode.Uri; root: string; rootIdentity: RootIdentity | undefined;
    identity: FileIdentity; isActive: () => boolean };
let selectedCompare: CompareItem | undefined;
let lastComparison: { left: CompareItem; right: CompareItem } | undefined;

function setCompareSource(item: CompareItem | undefined): void {
    selectedCompare = item;
    void vscode.commands.executeCommand('setContext', 'scratches.hasCompareSource', !!item);
}

function invalidateStaleCompareSource(): void {
    const item = selectedCompare;
    if (!item) { return; }
    try {
        if (!item.isActive()) { throw new Error('Scratch directory changed'); }
        assertInsideRoot(item.root, item.uri.fsPath, item.rootIdentity);
        const stat = fs.lstatSync(item.uri.fsPath);
        if (!stat.isFile() || !sameIdentity(item.identity, stat)) { throw new Error('Selected file changed'); }
    } catch { setCompareSource(undefined); }
}

async function openComparison(left: CompareItem, right: CompareItem): Promise<void> {
    if (left.uri.toString() === right.uri.toString()) { throw new Error('Select two different files'); }
    for (const item of [left, right]) {
        if (!item.isActive()) { throw new Error('Scratch directory changed; select the files again'); }
        assertInsideRoot(item.root, item.uri.fsPath, item.rootIdentity);
        await validateTextFile(item.uri.fsPath, item.identity);
        if (!item.isActive()) { throw new Error('Scratch directory changed; select the files again'); }
        assertInsideRoot(item.root, item.uri.fsPath, item.rootIdentity);
        if (!sameIdentity(item.identity, fs.lstatSync(item.uri.fsPath))) { throw new Error('Selected file was replaced'); }
    }
    for (const item of [left, right]) {
        if (!item.isActive()) { throw new Error('Scratch directory changed; select the files again'); }
        assertInsideRoot(item.root, item.uri.fsPath, item.rootIdentity);
        if (!sameIdentity(item.identity, fs.lstatSync(item.uri.fsPath))) { throw new Error('Selected file was replaced'); }
    }
    await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri,
        `${path.basename(left.uri.fsPath)} ↔ ${path.basename(right.uri.fsPath)}`, { preview: false });
    lastComparison = { left, right };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino;
}

function getRootIdentity(root: string): RootIdentity {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory()) { throw new Error('Scratch root is not a directory or is a symbolic link'); }
    return { dev: stat.dev, ino: stat.ino };
}

function assertInsideRoot(root: string, target: string, expectedRoot?: RootIdentity): void {
    const currentRoot = getRootIdentity(root);
    if (expectedRoot && !sameIdentity(expectedRoot, currentRoot)) {
        throw new Error('Scratch root changed; refresh the configuration before retrying');
    }
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Path is outside the scratch directory');
    }
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        if (fs.lstatSync(current).isSymbolicLink()) { throw new Error('Symbolic links are not supported'); }
    }
}

type FileSnapshot = Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;

function sameFile(a: FileSnapshot, b: FileSnapshot): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
        a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function assertExpectedSource(actual: fs.Stats, expected?: FileIdentity | FileSnapshot): void {
    if (!actual.isFile()) { throw new Error('Source is not a regular file'); }
    if (expected && !sameIdentity(expected, actual)) { throw new Error('Selected source was replaced; select it again'); }
    if (expected && 'size' in expected && !sameFile(expected, actual)) {
        throw new Error('File changed after confirmation');
    }
}

function selectedItemIdentity(root: string, item: FileItem, rootIdentity?: RootIdentity): FileIdentity {
    assertInsideRoot(root, item.uri.fsPath, rootIdentity);
    if (path.relative(root, item.uri.fsPath) === '') { throw new Error('Cannot modify the scratch root'); }
    const stat = fs.lstatSync(item.uri.fsPath);
    if ((item.type === vscode.FileType.File && !stat.isFile()) ||
        (item.type === vscode.FileType.Directory && !stat.isDirectory()) ||
        (item.type !== vscode.FileType.File && item.type !== vscode.FileType.Directory)) {
        throw new Error('Selected item has changed or is not a regular file or directory');
    }
    return { dev: stat.dev, ino: stat.ino };
}

// При ошибке удаления сохраняем обе копии, чтобы не потерять данные.
export async function moveFileExclusive(
    source: string,
    destination: string,
    operations: Pick<typeof fs.promises, 'lstat' | 'link' | 'copyFile' | 'unlink'> = fs.promises,
    beforeRemove?: () => void,
    expectedSource?: FileIdentity | FileSnapshot,
): Promise<void> {
    const original = await operations.lstat(source);
    assertExpectedSource(original, expectedSource);
    let copied = false;
    try {
        await operations.link(source, destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') { throw error; }
        try { await operations.copyFile(source, destination, fs.constants.COPYFILE_EXCL); }
        catch (copyError) {
            if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') { throw copyError; }
            throw new Error(`Copy failed; source was retained and destination may be incomplete: ${copyError}`);
        }
        copied = true;
    }
    let current: fs.Stats;
    try { current = await operations.lstat(source); }
    catch (error) { throw new Error(`Destination created, but source could not be checked: ${error}`); }
    // Создание жёсткой ссылки меняет ctime, поэтому для сравнения после link его не используем.
    if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size ||
        current.mtimeMs !== original.mtimeMs || (copied && current.ctimeMs !== original.ctimeMs)) {
        throw new Error('Source changed during move; both copies were retained');
    }
    try { beforeRemove?.(); }
    catch (error) { throw new Error(`Destination created, but source was retained: ${error}`); }
    try { await operations.unlink(source); }
    catch (error) { throw new Error(`Destination created but source could not be removed: ${error}`); }
}

async function moveFileWithEditors(
    source: string,
    destination: string,
    validate: () => void,
    expected?: FileIdentity | FileSnapshot,
): Promise<void> {
    const sourceUri = vscode.Uri.file(source);
    if (hasOpenDocument(sourceUri)) {
        const current = await fs.promises.lstat(source);
        assertExpectedSource(current, expected);
        validate();
        try { await renameInEditor(sourceUri, vscode.Uri.file(destination)); }
        catch (error) { throw new Error(`VS Code could not complete the move; check source and destination: ${error}`); }
        return;
    }

    await moveFileExclusive(source, destination, fs.promises, () => {
        validate();
        if (hasOpenDocument(sourceUri)) { throw new Error('File was opened during the move'); }
    }, expected);
}

export async function archiveFiles(
    root: string,
    files: string[],
    snapshots?: ReadonlyMap<string, FileSnapshot>,
    rootIdentity?: RootIdentity,
    ensureActive?: () => void,
): Promise<{ moved: number; failed: string[] }> {
    ensureActive?.();
    const trashPath = path.join(root, 'trash');
    assertInsideRoot(root, root, rootIdentity);
    directory.ensureDirectoryExists(trashPath);
    assertInsideRoot(root, trashPath, rootIdentity);
    let moved = 0;
    const failed: string[] = [];
    for (const fileName of files) {
        try {
            ensureActive?.();
            if (!validName(fileName)) { throw new Error('Invalid file name'); }
            const source = path.join(root, fileName);
            if (hasDirtyDocument(vscode.Uri.file(source))) { throw new Error('Unsaved document'); }
            assertInsideRoot(root, source, rootIdentity);
            assertInsideRoot(root, trashPath, rootIdentity);
            const expected = snapshots?.get(fileName);
            if (snapshots && !expected) { throw new Error('Missing file snapshot'); }
            await moveFileWithEditors(source, path.join(trashPath, fileName), () => {
                ensureActive?.();
                assertInsideRoot(root, source, rootIdentity);
                assertInsideRoot(root, trashPath, rootIdentity);
                if (hasDirtyDocument(vscode.Uri.file(source))) { throw new Error('Unsaved document'); }
            }, expected);
            moved++;
        } catch { failed.push(fileName); }
    }
    return { moved, failed };
}

export enum ActionFile {
    COPY = 0,
    CUT = 1
}

export interface DirectoryViewerUI {
    input(options: vscode.InputBoxOptions): Thenable<string | undefined>;
    confirm(message: string, ...items: string[]): Thenable<string | undefined>;
    openFile(filePath: string, preserveFocus?: boolean): Promise<void>;
    copyText(text: string): Promise<void>;
    readText?(): Promise<string>;
    deleteItem?(uri: vscode.Uri, options: { recursive: boolean; useTrash: boolean }): Thenable<void>;
    error(message: string): void;
    warn(message: string): void;
}

const defaultUI: DirectoryViewerUI = {
    input: options => vscode.window.showInputBox(options),
    confirm: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
    openFile: async (filePath, preserveFocus) => {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath), { preserveFocus });
    },
    copyText: async text => { await vscode.env.clipboard.writeText(text); },
    readText: async () => vscode.env.clipboard.readText(),
    error: message => { vscode.window.showErrorMessage(message); },
    warn: message => { vscode.window.showWarningMessage(message); },
};


export class Scratches {
    private static disposables: vscode.Disposable[] = [];
    private static extensionsManager: fileExtension.FileExtensionsManager | undefined;
    private static viewers = new Map<string, DirectoryViewer>();
    private static rootWatcher: RootWatcher | undefined;
    private static projectTree: vscode.TreeView<FileItem> | undefined;

    public static dispose() {
        this.rootWatcher?.dispose();
        this.rootWatcher = undefined;
        for (const disposable of this.disposables.splice(0)) { disposable.dispose(); }
        this.viewers.clear();
        activeDrag = undefined;
        this.projectTree = undefined;
        setCompareSource(undefined);
        lastComparison = undefined;
        copiedFileUri = null;
        copiedFileRoot = null;
        copiedRootIdentity = undefined;
        copiedFileIdentity = undefined;
        copiedSourceIsActive = undefined;
        copiedBatch = undefined;
        actionWithFile = null;
    }

    public static refreshViews(origin: DirectoryViewer): void {
        invalidateStaleCompareSource();
        origin.refresh();
        for (const viewer of this.viewers.values()) {
            if (viewer !== origin) { viewer.refresh(); }
        }
    }

    public static createView(context: vscode.ExtensionContext) {
        setCompareSource(undefined);
        lastComparison = undefined;
        scratchesDirectory = directory.getRootScratchesDirectory();
        if (!scratchesDirectory) {
            this.rootWatcher?.setRoot('');
            for (const viewer of this.viewers.values()) { viewer.setRootPath(''); }
            copiedFileUri = null;
            copiedFileRoot = null;
            copiedRootIdentity = undefined;
            copiedFileIdentity = undefined;
            copiedSourceIsActive = undefined;
            copiedBatch = undefined;
            actionWithFile = null;
            return;
        }
        try {
            if (!fs.lstatSync(scratchesDirectory).isDirectory()) { throw new Error('Not a directory or is a symbolic link'); }
            directory.ensureDirectoryExists(scratchesDirectory);

            const fileExtenrionsManager = this.extensionsManager ??= new fileExtension.FileExtensionsManager(context.globalState);

            const folders = vscode.workspace.workspaceFolders ?? [];
            const savedProject = context.workspaceState.get<{ root: string; name: string }>('scratches.selectedSavedProject');
            const selectedUri = context.workspaceState.get<string>('scratches.selectedWorkspaceFolder');
            const selectedFolder = folders.find(folder => folder.uri.toString() === selectedUri) ?? folders[0];
            let projectDirectory = '';
            let projectLabel = selectedFolder?.name;
            if (savedProject?.root === scratchesDirectory && validName(savedProject.name) && /^[\s\S]+-[a-f0-9]{64}$/.test(savedProject.name)) {
                const candidate = path.join(scratchesDirectory, '.projects', savedProject.name);
                try {
                    assertInsideRoot(scratchesDirectory, candidate, getRootIdentity(scratchesDirectory));
                    if (fs.lstatSync(candidate).isDirectory()) {
                        projectDirectory = candidate;
                        projectLabel = savedProject.name.replace(/-([a-f0-9]{8})[a-f0-9]{56}$/, ' ($1)');
                    }
                } catch { /* Недоступный сохранённый проект заменяется открытой папкой. */ }
            }
            if (!projectDirectory) { projectDirectory = directory.getDirectoryProject(selectedFolder) ?? ''; }
            const roots: [string, string][] = [
                ['sectionProjectFiles', projectDirectory],
                ['sectionSharedFiles', directory.getDirectoryShare()],
                ['sectionAllFiles', scratchesDirectory],
            ];
            for (const [viewId, rootPath] of roots) {
                const existing = this.viewers.get(viewId);
                if (existing) { existing.setRootPath(rootPath); }
                else {
                    const { viewer, disposables, treeView } = DirectoryViewer.initDirectoryViewer(context, viewId, rootPath, fileExtenrionsManager);
                    this.viewers.set(viewId, viewer);
                    if (viewId === 'sectionProjectFiles') { this.projectTree = treeView; }
                    this.disposables.push(...disposables);
                }
            }
            if (this.projectTree) { this.projectTree.description = projectLabel; }
            try {
                this.rootWatcher ??= new RootWatcher(() => {
                    invalidateStaleCompareSource();
                    for (const viewer of this.viewers.values()) { viewer.refresh(); }
                });
                this.rootWatcher.setRoot(scratchesDirectory, getRootIdentity(scratchesDirectory));
            } catch (error) { vscode.window.showWarningMessage(`Could not watch scratch directory; use Refresh: ${error}`); }
            copiedFileUri = null;
            copiedFileRoot = null;
            copiedRootIdentity = undefined;
            copiedFileIdentity = undefined;
            copiedSourceIsActive = undefined;
            copiedBatch = undefined;
            actionWithFile = null;
        } catch (error) {
            this.rootWatcher?.setRoot('');
            for (const viewer of this.viewers.values()) { viewer.setRootPath(''); }
            copiedFileUri = null;
            copiedFileRoot = null;
            copiedRootIdentity = undefined;
            copiedFileIdentity = undefined;
            copiedSourceIsActive = undefined;
            copiedBatch = undefined;
            actionWithFile = null;
            vscode.window.showErrorMessage(`Could not initialize scratch directory "${scratchesDirectory}": ${error}`);
        }
    }

    public static async swapComparison(): Promise<void> {
        const pair = lastComparison;
        if (!pair) { vscode.window.showErrorMessage('No scratch comparison to swap.'); return; }
        try { await openComparison(pair.right, pair.left); }
        catch (error) { vscode.window.showErrorMessage(`Could not compare files: ${error}`); }
    }

    public static async selectWorkspaceFolder(context: vscode.ExtensionContext,
        pick: (choices: readonly ProjectChoice[]) => Promise<ProjectChoice | undefined> = async choices =>
            (await vscode.window.showQuickPick(choices.map(choice => choice.kind === 'workspace' ? {
                label: choice.folder.name, description: `Workspace: ${choice.folder.uri.toString(true)}`, choice,
            } : {
                label: choice.name.replace(/-([a-f0-9]{8})[a-f0-9]{56}$/, ' ($1)'), description: 'Saved scratch project', choice,
            }), { placeHolder: 'Select an open workspace folder or saved scratch project' }))?.choice): Promise<void> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        try {
            const root = directory.getRootScratchesDirectory();
            if (!root) { throw new Error('Select a scratch directory first'); }
            const identity = getRootIdentity(root);
            assertInsideRoot(root, root, identity);
            const projectsPath = path.join(root, '.projects');
            let entries: fs.Dirent[] = [];
            try {
                assertInsideRoot(root, projectsPath, identity);
                entries = await fs.promises.readdir(projectsPath, { withFileTypes: true });
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            const choices: ProjectChoice[] = [
                ...folders.map(folder => ({ kind: 'workspace' as const, folder })),
                ...entries.filter(entry => entry.isDirectory() && /^[\s\S]+-[a-f0-9]{64}$/.test(entry.name))
                    .map(entry => ({ kind: 'saved' as const, name: entry.name })),
            ];
            if (!choices.length) { vscode.window.showInformationMessage('No workspace folders or saved scratch projects found.'); return; }
            const selected = await pick(choices);
            if (!selected) { return; }
            if (root !== directory.getRootScratchesDirectory()) { throw new Error('Scratch directory changed'); }
            assertInsideRoot(root, root, identity);
            if (selected.kind === 'workspace') {
                const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === selected.folder.uri.toString());
                if (!folder) { throw new Error('Workspace folder is no longer available'); }
                directory.ensureProjectStoragePath(root, folder.uri);
                await context.workspaceState.update('scratches.selectedWorkspaceFolder', folder.uri.toString());
                await context.workspaceState.update('scratches.selectedSavedProject', undefined);
            } else {
                if (!choices.some(choice => choice.kind === 'saved' && choice.name === selected.name)) { throw new Error('Unknown scratch project'); }
                const candidate = path.join(projectsPath, selected.name);
                assertInsideRoot(root, candidate, identity);
                if (!fs.lstatSync(candidate).isDirectory()) { throw new Error('Scratch project is no longer available'); }
                await context.workspaceState.update('scratches.selectedSavedProject', { root, name: selected.name });
            }
            this.createView(context);
        } catch (error) { vscode.window.showErrorMessage(`Could not select project: ${error}`); }
    }

    public static async compareActiveWithClipboard(): Promise<void> {
        const uri = vscode.window.activeTextEditor?.document.uri;
        const viewer = this.viewers.get('sectionAllFiles');
        if (!uri || uri.scheme !== 'file' || !viewer) {
            vscode.window.showErrorMessage('Open a scratch file to compare with the clipboard.');
            return;
        }
        await viewer.compareWithClipboard({ uri, type: vscode.FileType.File });
    }
}


export class DirectoryViewer implements vscode.TreeDataProvider<FileItem> {
    public selectItem: FileItem | null = null;
    public selectedItems: readonly FileItem[] = [];
    private rootVersion = 0;
    private rootIdentity: RootIdentity | undefined;
    private cleanupPreview: { paths: Set<string> } | undefined;
    private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null | void> = new vscode.EventEmitter<FileItem | undefined | null | void>();

    get onDidChangeTreeData(): vscode.Event<FileItem | undefined | null | void> {
        return this._onDidChangeTreeData.event;
    }

    /**
     * Initializes the directory viewer and sets up commands.
     * @param context - The extension context.
     * @param viewId - The ID of the tree view.
     * @param directoryPath - The root directory to display.
     * @param fileExtensionsManager - Manager for handling file extensions.
     */
    public static initDirectoryViewer(
        context: vscode.ExtensionContext,
        viewId: string,
        directoryPath: string,
        fileExtenrionsManager: fileExtension.FileExtensionsManager,
    ) {
        if (directoryPath) { directory.ensureDirectoryExists(directoryPath); }

        const directoryViewer = new DirectoryViewer(context, directoryPath, viewId, fileExtenrionsManager, defaultUI, systemFileClipboard);
        directoryViewer.updateSelection([]);
        const treeView = vscode.window.createTreeView(viewId, { treeDataProvider: directoryViewer, showCollapseAll: true, canSelectMany: true,
            dragAndDropController: directoryViewer.dragController() });
        const disposables: vscode.Disposable[] = [treeView, directoryViewer,
            treeView.onDidChangeSelection(event => { directoryViewer.updateSelection(event.selection); })];

        disposables.push(vscode.commands.registerCommand(viewId + ".refresh", () => directoryViewer.refresh()));
        disposables.push(vscode.commands.registerCommand(viewId + ".newScratchFile", () => directoryViewer.newScratchFile()));
        disposables.push(vscode.commands.registerCommand(viewId + ".newFolder", (node: FileItem) => directoryViewer.newFolder(node)));
        disposables.push(vscode.commands.registerCommand(viewId + ".delete", (node: FileItem, selected?: FileItem[]) => directoryViewer.delete(node, selected)));
        disposables.push(vscode.commands.registerCommand(viewId + ".openScratchFile", (node: FileItem) => directoryViewer.open(node)));
        disposables.push(vscode.commands.registerCommand(viewId + ".rename", (node: FileItem) => directoryViewer.rename(node)));
        disposables.push(vscode.commands.registerCommand(viewId + ".copy", (node: FileItem, selected?: FileItem[]) => directoryViewer.copy(node, selected)));
        disposables.push(vscode.commands.registerCommand(viewId + ".cut", (node: FileItem, selected?: FileItem[]) => directoryViewer.cut(node, selected)));
        disposables.push(vscode.commands.registerCommand(viewId + ".paste", (node: FileItem) => directoryViewer.paste(node)));
        disposables.push(vscode.commands.registerCommand(viewId + ".copyPath", (node: FileItem) => directoryViewer.copyPath(node)));
        disposables.push(vscode.commands.registerCommand(viewId + ".clear", () => directoryViewer.clear()));
        disposables.push(vscode.commands.registerCommand(viewId + ".searchContent", () => directoryViewer.searchContent()));
        disposables.push(vscode.commands.registerCommand(viewId + ".selectForCompare", (node: FileItem) => directoryViewer.selectForCompare(node)));
        disposables.push(vscode.commands.registerCommand(viewId + ".compareWithSelected", (node: FileItem) => directoryViewer.compareWithSelected(node)));
        disposables.push(vscode.commands.registerCommand(viewId + ".compareSelected", (node: FileItem, selected?: FileItem[]) => directoryViewer.compareSelected(node, selected)));
        disposables.push(vscode.commands.registerCommand(viewId + ".compareWithClipboard", (node: FileItem) => directoryViewer.compareWithClipboard(node)));
        return { viewer: directoryViewer, disposables, treeView };
    }

    constructor(
        public readonly context: vscode.ExtensionContext,
        public rootPath: string,
        public readonly viewId: string,
        public readonly fileExtenrionsManager: Pick<fileExtension.FileExtensionsManager, 'selectFileExtension' | 'recordUsage'>,
        private readonly ui: DirectoryViewerUI = defaultUI,
        private readonly fileClipboard?: FileClipboard,
    ) { this.rootIdentity = rootPath ? getRootIdentity(rootPath) : undefined; }

    setRootPath(rootPath: string): void {
        this.rootVersion++;
        this.cleanupPreview = undefined;
        invalidateStaleCompareSource();
        this.rootPath = rootPath;
        this.rootIdentity = rootPath ? getRootIdentity(rootPath) : undefined;
        this.updateSelection([]);
        this.refresh();
    }

    updateSelection(items: readonly FileItem[]): void {
        invalidateStaleCompareSource();
        this.selectedItems = items;
        this.selectItem = items[0] ?? null;
        void vscode.commands.executeCommand('setContext', `scratches.${this.viewId}.canCompareSelected`, canCompareSelection(items));
    }

    private commandSelection(element: FileItem | null, selection?: readonly FileItem[]): readonly FileItem[] {
        if (element) {
            return selection?.some(item => item.uri.toString() === element.uri.toString()) ? selection : [element];
        }
        return this.selectedItems.length ? this.selectedItems : this.selectItem ? [this.selectItem] : [];
    }

    private compareItem(item: FileItem): CompareItem {
        if (item.type !== vscode.FileType.File) { throw new Error('Select a regular text file'); }
        const identity = selectedItemIdentity(this.rootPath, item, this.rootIdentity);
        const version = this.rootVersion;
        return { uri: item.uri, root: this.rootPath, rootIdentity: this.rootIdentity,
            identity, isActive: () => this.rootVersion === version };
    }

    async selectForCompare(element: FileItem | null): Promise<void> {
        const item = element ?? this.selectItem;
        if (!item) { this.ui.error('Select a file to compare.'); return; }
        try {
            const candidate = this.compareItem(item);
            await validateTextFile(candidate.uri.fsPath, candidate.identity);
            if (!candidate.isActive()) { throw new Error('Scratch directory changed'); }
            assertInsideRoot(candidate.root, candidate.uri.fsPath, candidate.rootIdentity);
            if (!sameIdentity(candidate.identity, fs.lstatSync(candidate.uri.fsPath))) { throw new Error('Selected file was replaced'); }
            setCompareSource(candidate);
            vscode.window.showInformationMessage(`Selected for comparison: ${path.basename(candidate.uri.fsPath)}`);
        } catch (error) { this.ui.error(`Could not select file for comparison: ${error}`); }
    }

    async compareWithSelected(element: FileItem | null): Promise<void> {
        const item = element ?? this.selectItem;
        const first = selectedCompare;
        if (!first || !item) { this.ui.error('Select a first file and a second file to compare.'); return; }
        try { await openComparison(first, this.compareItem(item)); }
        catch (error) { this.ui.error(`Could not compare files: ${error}`); }
    }

    async compareSelected(element: FileItem | null, selection?: readonly FileItem[]): Promise<void> {
        const items = this.commandSelection(element, selection);
        if (!canCompareSelection(items)) { this.ui.error('Select exactly two different files to compare.'); return; }
        try { await openComparison(this.compareItem(items[0]), this.compareItem(items[1])); }
        catch (error) { this.ui.error(`Could not compare files: ${error}`); }
    }

    async compareWithClipboard(element: FileItem | null): Promise<void> {
        const item = element ?? this.selectItem;
        if (!item) { this.ui.error('Select a scratch file to compare.'); return; }
        try {
            const candidate = this.compareItem(item);
            const check = () => {
                if (!candidate.isActive()) { throw new Error('Scratch directory changed'); }
                assertInsideRoot(candidate.root, candidate.uri.fsPath, candidate.rootIdentity);
                const stat = fs.lstatSync(candidate.uri.fsPath);
                if (!stat.isFile() || !sameIdentity(candidate.identity, stat)) { throw new Error('Selected file was replaced'); }
            };
            await validateTextFile(candidate.uri.fsPath, candidate.identity);
            check();
            const content = await (this.ui.readText ?? (() => vscode.env.clipboard.readText()))();
            check();
            if (Buffer.byteLength(content, 'utf8') > MAX_COMPARE_BYTES) { throw new Error('Clipboard text exceeds the 10 MiB comparison limit'); }
            const source = await vscode.workspace.openTextDocument(candidate.uri);
            check();
            const temporary = await vscode.workspace.openTextDocument({ language: source.languageId, content });
            check();
            await vscode.commands.executeCommand('vscode.diff', candidate.uri, temporary.uri,
                `${path.basename(candidate.uri.fsPath)} ↔ Clipboard`, { preview: false });
        } catch (error) { this.ui.error(`Could not compare with clipboard: ${error}`); }
    }

    /**
     * Opens the specified file item in a new text document.
     * 
     * If the provided element is a file, it opens the file in the editor while preserving focus.
     * 
     * @param {FileItem} element - The file item to open.
     */
    async open(element: FileItem) {
        try {
            if (!element) { throw new Error('No item selected'); }
            assertInsideRoot(this.rootPath, element.uri.fsPath, this.rootIdentity);
            const stat = fs.lstatSync(element.uri.fsPath);
            if (element.type === vscode.FileType.File && stat.isFile()) {
                this.selectItem = element;
                await this.ui.openFile(element.uri.fsPath, true);
            } else if (element.type === vscode.FileType.Directory && stat.isDirectory()) {
                this.selectItem = element;
            } else { throw new Error('The item has changed or is not a regular file or directory'); }
        } catch (error) {
            this.updateSelection([]);
            this.ui.error(`Could not open item: ${error}`);
        }
    }

    /**
     * Clears files older than a specified date by moving them to a "trash" directory.
     * 
     * This asynchronous function prompts the user to input a date in the format "YYYY-MM-DD". 
     * It scans the specified root directory for files that have a date prefix in the format 
     * "YYYYMMDD". If the file's date is older than the user-specified date, the file 
     * will be moved to a "trash" directory. The user is prompted for confirmation before 
     * proceeding with the move. Informational messages are displayed to the user throughout 
     * the process to indicate the outcome.
     */
    async clear() {
        const rootPath = this.rootPath;
        const rootVersion = this.rootVersion;
        const proposed_date = new Date(Date.now());
        proposed_date.setDate(proposed_date.getDate() - 30);

        const userStringDate = await this.ui.input({
            prompt: "Specify a date. Files older than this will be moved to the 'trash' directory. Format: 'YYYY-MM-DD'.",
            value: proposed_date.toISOString().split('T')[0],
        });

        if (!userStringDate) { return; }
        if (rootVersion !== this.rootVersion) { vscode.window.showWarningMessage('Scratch directory changed; operation cancelled.'); return; }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(userStringDate)) {
            vscode.window.showInformationMessage(`Invalid date format: ${userStringDate}!`);
            return;
        }

        const userDate = new Date(userStringDate);
        if (isNaN(userDate.getTime()) || userDate.toISOString().slice(0, 10) !== userStringDate) {
            vscode.window.showInformationMessage(`Invalid date format: ${userStringDate}!`);
            return;
        }


        let files: string[];
        const rootIdentity = this.rootIdentity;
        try { assertInsideRoot(rootPath, rootPath, rootIdentity); files = await fs.promises.readdir(rootPath); }
        catch (error) { vscode.window.showErrorMessage(`Could not read scratch directory: ${error}`); return; }
        const filesToMove: string[] = [];
        const snapshots = new Map<string, FileSnapshot>();
        for (const fileName of files) {
            const dateMatch = fileName.match(/^(\d{4})(\d{2})(\d{2})-\d{6}/);
            if (!dateMatch) { continue; }
            let stat: fs.Stats;
            try { stat = await fs.promises.lstat(path.join(rootPath, fileName)); }
            catch (error) {
                this.ui.error(`Could not inspect "${fileName}"; cleanup cancelled: ${error}`);
                return;
            }
            const dateString = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
            const fileDate = new Date(dateString);
            if (!isNaN(fileDate.getTime()) && fileDate.toISOString().slice(0, 10) === dateString &&
                stat.isFile() && fileDate <= userDate && stat.mtime <= userDate) {
                filesToMove.push(fileName);
                snapshots.set(fileName, stat);
            }
        }
        if (rootVersion !== this.rootVersion) { vscode.window.showWarningMessage('Scratch directory changed; operation cancelled.'); return; }
        try { assertInsideRoot(rootPath, rootPath, rootIdentity); }
        catch (error) { this.ui.error(`Could not inspect scratch directory; cleanup cancelled: ${error}`); return; }

        if (filesToMove.length === 0) {
            vscode.window.showInformationMessage(`Nothing to move to "trash"`);
            return;
        }

        const preview = { paths: new Set(filesToMove.map(name => path.join(rootPath, name))) };
        this.cleanupPreview = preview;
        this.refresh();
        let confirm: string | undefined;
        try {
            confirm = await this.ui.confirm(
                `Move ${filesToMove.length} files to the "trash"?`,
                "Yes",
                "No"
            );
        } finally {
            if (this.cleanupPreview === preview) {
                this.cleanupPreview = undefined;
                this.refresh();
            }
        }

        if (confirm === "Yes") {
            if (rootVersion !== this.rootVersion) { vscode.window.showWarningMessage('Scratch directory changed; operation cancelled.'); return; }
            let result: { moved: number; failed: string[] };
            try { result = await archiveFiles(rootPath, filesToMove, snapshots, rootIdentity, () => {
                if (rootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
            }); }
            catch (error) { vscode.window.showErrorMessage(`Could not access trash: ${error}`); return; }
            const { moved, failed } = result;
            if (failed.length) {
                const reason = rootVersion !== this.rootVersion ? 'Scratch directory changed; cleanup stopped. ' : '';
                this.ui.warn(`${reason}Moved ${moved} files; could not move ${failed.length}: ${failed.join(', ')}. Check source and trash before retrying: destination copies may exist.`);
            } else {
                vscode.window.showInformationMessage(`Successfully moved ${moved} files to "trash"`);
            }
            Scratches.refreshViews(this);
        }
    }

    /**
    * Copies or cuts the specified file item, or the currently selected item if none is provided.
    * 
    * This function checks if the selected element is valid and whether it is a file or a directory. 
    * If the element is a directory, an informational message is displayed, as directories cannot be copied. 
    * The URI of the copied or cut file is stored for later use.
    * 
    * @param {FileItem | null} element - The file item to copy or cut. If null, the currently selected item is used.
    */
    _copyCut(element: FileItem | null): boolean {
        if (!element) {
            element = this.selectItem;
        }

        if (!element) {
            vscode.window.showInformationMessage(`No file selected.`);
            return false;
        }

        if (element.type !== vscode.FileType.File) {
            vscode.window.showInformationMessage(`Only regular files can be copied or moved.`);
            return false;
        }

        let stat: fs.Stats;
        try {
            assertInsideRoot(this.rootPath, element.uri.fsPath, this.rootIdentity);
            stat = fs.lstatSync(element.uri.fsPath);
            if (!stat.isFile()) { throw new Error('Source is not a regular file'); }
        } catch (error) {
            this.ui.error(`Could not select file: ${error}`);
            return false;
        }

        copiedFileUri = element.uri;
        copiedBatch = undefined;
        copiedFileRoot = this.rootPath;
        copiedRootIdentity = this.rootIdentity;
        copiedFileIdentity = { dev: stat.dev, ino: stat.ino };
        const sourceRootVersion = this.rootVersion;
        copiedSourceIsActive = () => this.rootVersion === sourceRootVersion;
        return true;
    }

    /**
     * Copies the specified file item, or the currently selected item if none is provided.
     * 
     * This function calls the internal copy/cut function and sets the action to COPY.
     * 
     * @param {FileItem | null} element - The file item to copy. If null, the currently selected item is used.
     */
    copy(element: FileItem | null, selection?: readonly FileItem[]) {
        const items = this.commandSelection(element, selection);
        if (items.length > 1 || items[0]?.type === vscode.FileType.Directory) { return this.selectBatch(items, ActionFile.COPY); }
        if (this._copyCut(element)) {
            actionWithFile = ActionFile.COPY;
            nativeFailureIdentity = undefined;
            const uri = copiedFileUri;
            const identity = copiedFileIdentity;
            if (this.fileClipboard && uri && identity) {
                const clipboard = this.fileClipboard;
                const sourceRoot = copiedFileRoot;
                const sourceRootIdentity = copiedRootIdentity;
                const sourceIsActive = copiedSourceIsActive;
                nativeOperation = nativeOperation.catch(() => undefined).then(async () => {
                    if (copiedFileIdentity !== identity || actionWithFile !== ActionFile.COPY) { return; }
                    if (!sourceRoot || !sourceIsActive?.()) { throw new Error('Source scratch directory changed'); }
                    assertInsideRoot(sourceRoot, uri.fsPath, sourceRootIdentity);
                    assertExpectedSource(fs.lstatSync(uri.fsPath), identity);
                    if (hasDirtyDocument(uri)) { throw new Error('Save unsaved documents before copying'); }
                    const result = await clipboard.write([uri.fsPath]);
                    if (copiedFileIdentity === identity && actionWithFile === ActionFile.COPY) {
                        nativeSelection = { identity, changeCount: result.changeCount };
                    }
                }).catch(error => {
                    if (copiedFileIdentity === identity) { nativeSelection = undefined; nativeFailureIdentity = identity; }
                    this.ui.error(`Could not copy file to system clipboard: ${error}`);
                });
                return nativeOperation;
            }
        }
    }

    /**
     * Cuts the specified file item, or the currently selected item if none is provided.
     * 
     * This function calls the internal copy/cut function and sets the action to CUT.
     * 
     * @param {FileItem | null} element - The file item to cut. If null, the currently selected item is used.
     */
    cut(element: FileItem | null, selection?: readonly FileItem[]) {
        const items = this.commandSelection(element, selection);
        if (items.length > 1 || items[0]?.type === vscode.FileType.Directory) { return this.selectBatch(items, ActionFile.CUT); }
        if (this._copyCut(element)) {
            actionWithFile = ActionFile.CUT;
            nativeFailureIdentity = undefined;
            const identity = copiedFileIdentity;
            const uri = copiedFileUri;
            if (this.fileClipboard && identity && uri) {
                const clipboard = this.fileClipboard;
                const sourceRoot = copiedFileRoot;
                const sourceRootIdentity = copiedRootIdentity;
                const sourceIsActive = copiedSourceIsActive;
                nativeOperation = nativeOperation.catch(() => undefined).then(async () => {
                    if (copiedFileIdentity !== identity || actionWithFile !== ActionFile.CUT) { return; }
                    if (!sourceRoot || !sourceIsActive?.()) { throw new Error('Source scratch directory changed'); }
                    assertInsideRoot(sourceRoot, uri.fsPath, sourceRootIdentity);
                    assertExpectedSource(fs.lstatSync(uri.fsPath), identity);
                    if (hasDirtyDocument(uri)) { throw new Error('Save unsaved documents before moving'); }
                    const result = await clipboard.write([uri.fsPath]);
                    if (copiedFileIdentity === identity && actionWithFile === ActionFile.CUT) {
                        nativeSelection = { identity, changeCount: result.changeCount };
                    }
                }).catch(error => {
                    if (copiedFileIdentity === identity) { nativeSelection = undefined; nativeFailureIdentity = identity; }
                    this.ui.error(`Could not copy file to system clipboard: ${error}`);
                });
                return nativeOperation;
            }
        }
    }

    private makeBatch(items: readonly FileItem[], action: ActionFile): NonNullable<typeof copiedBatch> {
        if (!items.length || items.length > 100) { throw new Error('Select between 1 and 100 items'); }
        const all = [...new Map(items.map(item => [item.uri.fsPath, item])).values()];
        const unique = all.filter(item => !all.some(parent => {
            if (parent === item || parent.type !== vscode.FileType.Directory) { return false; }
            const relative = path.relative(parent.uri.fsPath, item.uri.fsPath);
            return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        }));
        const entries = unique.map(item => {
            const identity = selectedItemIdentity(this.rootPath, item, this.rootIdentity);
            return { uri: item.uri, identity, type: item.type };
        });
        const sourceRoot = this.rootPath;
        const sourceRootIdentity = this.rootIdentity;
        const sourceRootVersion = this.rootVersion;
        const token = entries[0].identity;
        return { entries, root: sourceRoot, rootIdentity: sourceRootIdentity,
            isActive: () => this.rootVersion === sourceRootVersion, action, token };
    }

    private selectBatch(items: readonly FileItem[], action: ActionFile): Promise<void> | void {
        let batch: NonNullable<typeof copiedBatch>;
        try { batch = this.makeBatch(items, action); }
        catch (error) { this.ui.error(`Could not select items: ${error}`); return; }
        const { entries, root: sourceRoot, rootIdentity: sourceRootIdentity, token } = batch;
        copiedBatch = batch;
        copiedFileUri = entries[0].uri;
        copiedFileRoot = sourceRoot;
        copiedRootIdentity = sourceRootIdentity;
        copiedFileIdentity = token;
        copiedSourceIsActive = batch.isActive;
        actionWithFile = action;
        nativeFailureIdentity = undefined;
        if (this.fileClipboard) {
            const clipboard = this.fileClipboard;
            nativeOperation = nativeOperation.catch(() => undefined).then(async () => {
                if (copiedBatch !== batch) { return; }
                if (!batch.isActive()) { throw new Error('Source scratch directory changed'); }
                for (const entry of entries) {
                    assertInsideRoot(sourceRoot, entry.uri.fsPath, sourceRootIdentity);
                    if (!sameIdentity(entry.identity, selectedItemIdentity(sourceRoot, entry, sourceRootIdentity))) {
                        throw new Error('Selected item was replaced');
                    }
                    if (hasDirtyDocument(entry.uri)) { throw new Error('Save unsaved documents before copying or moving'); }
                }
                const result = await clipboard.write(entries.map(entry => entry.uri.fsPath));
                if (copiedBatch === batch) { nativeSelection = { identity: token, changeCount: result.changeCount }; }
            }).catch(error => {
                if (copiedBatch === batch) { nativeSelection = undefined; nativeFailureIdentity = token; }
                this.ui.error(`Could not copy items to system clipboard: ${error}`);
            });
            return nativeOperation;
        }
    }

    public dragController(): vscode.TreeDragAndDropController<FileItem> {
        return {
            dragMimeTypes: [],
            dropMimeTypes: [...scratchTreeIds.map(treeMime), 'files', 'text/uri-list'],
            handleDrag: (items, _transfer, token) => {
                activeDrag = undefined;
                if (token.isCancellationRequested) { return; }
                try { activeDrag = { sourceView: this.viewId, batch: this.makeBatch(items, ActionFile.CUT) }; }
                catch (error) { this.ui.error(`Could not drag items: ${error}`); }
            },
            handleDrop: async (target, transfer, token) => {
                const drag = activeDrag;
                activeDrag = undefined;
                if (token.isCancellationRequested) { return; }
                if (drag && transfer.get(treeMime(drag.sourceView))) {
                    await this.pasteBatch(drag.batch, target ?? null, this.rootVersion, true, token);
                    return;
                }
                if (process.platform !== 'darwin' || vscode.env.uiKind !== vscode.UIKind.Desktop || vscode.env.remoteName) {
                    this.ui.error('External file drops are supported only in local desktop VS Code on macOS.'); return;
                }
                const version = this.rootVersion;
                try {
                    const paths = new Set<string>();
                    for (const [, item] of transfer) {
                        const uri = item.asFile()?.uri;
                        if (uri?.scheme === 'file' && !uri.authority) { paths.add(uri.fsPath); }
                    }
                    const uriList = transfer.get('text/uri-list');
                    if (uriList) {
                        for (const line of (await uriList.asString()).split(/\r?\n/)) {
                            if (!line || line.startsWith('#')) { continue; }
                            const uri = vscode.Uri.parse(line, true);
                            if (uri.scheme !== 'file' || uri.authority) { throw new Error('Only local file URIs are supported'); }
                            paths.add(uri.fsPath);
                        }
                    }
                    if (token.isCancellationRequested) { return; }
                    await this.pasteSystemFiles([...paths], target ?? null, version, true, token);
                } catch (error) { this.ui.error(`Could not import dropped items: ${error}`); }
            },
        };
    }
    /**
     * Pastes the previously copied or cut file to the specified location.
     * 
     * If no element is specified, it uses the currently selected item.
     * If the destination is a directory, the file will be pasted there; otherwise, it will be pasted 
     * in the parent directory of the selected item. If a file with the same name already exists, 
     * an informational message is displayed. The action can be either COPY or CUT.
     * 
     * @param {FileItem | null} element - The destination file item. If null, uses the currently selected item.
     */
    async paste(element: FileItem | null) {
        const initialVersion = this.rootVersion;
        if (this.fileClipboard) {
            try {
                await nativeOperation;
                if (nativeFailureIdentity && nativeFailureIdentity === copiedFileIdentity) {
                    throw new Error('Clipboard write failed; select a file again before pasting');
                }
                const content = await this.fileClipboard.read();
                if (initialVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                if (!nativeSelection || nativeSelection.identity !== copiedFileIdentity || nativeSelection.changeCount !== content.changeCount) {
                    await this.pasteSystemFiles(content.paths, element, initialVersion);
                    return;
                }
            } catch (error) { this.ui.error(`Could not read system clipboard: ${error}`); return; }
        }
        if (copiedBatch) { await this.pasteBatch(copiedBatch, element, initialVersion); return; }
        const sourceUri = copiedFileUri;
        const sourceRoot = copiedFileRoot;
        const sourceRootIdentity = copiedRootIdentity;
        const sourceIdentity = copiedFileIdentity;
        const sourceIsActive = copiedSourceIsActive;
        const action = actionWithFile;
        const destinationRoot = this.rootPath;
        const destinationRootIdentity = this.rootIdentity;
        const destinationRootVersion = this.rootVersion;
        if (!sourceUri) {
            vscode.window.showInformationMessage(`Nothing was copied!`);
            return;
        }

        let newFilePath: string = destinationRoot;

        if (!element) {
            element = this.selectItem;
        }

        if (element) {
            if (element.type === vscode.FileType.Directory) {
                newFilePath = element.uri.fsPath;
            } else {
                newFilePath = path.resolve(element.uri.fsPath, '..');
            }
        }

        newFilePath = path.resolve(newFilePath, path.basename(sourceUri.fsPath));
        if (fs.existsSync(newFilePath)) {
            vscode.window.showInformationMessage(`A file named "${newFilePath}" already exists!`);
            return;
        }

        try {
            if (!sourceRoot || !sourceIdentity || !sourceIsActive) { throw new Error('Missing source directory or file identity'); }
            if (!sourceIsActive()) { throw new Error('Source scratch directory changed; select the file again'); }
            assertInsideRoot(sourceRoot, sourceUri.fsPath, sourceRootIdentity);
            assertInsideRoot(destinationRoot, path.dirname(newFilePath), destinationRootIdentity);
            switch (action) {
                case ActionFile.COPY: {
                    if (hasDirtyDocument(sourceUri)) { throw new Error('Save unsaved documents before copying'); }
                    const original = await fs.promises.lstat(sourceUri.fsPath);
                    if (!original.isFile()) { throw new Error('Source is not a regular file'); }
                    if (!sameIdentity(sourceIdentity, original)) { throw new Error('Selected source was replaced; select it again'); }
                    if (destinationRootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                    if (!sourceIsActive()) { throw new Error('Source scratch directory changed'); }
                    assertInsideRoot(sourceRoot, sourceUri.fsPath, sourceRootIdentity);
                    assertInsideRoot(destinationRoot, path.dirname(newFilePath), destinationRootIdentity);
                    if (hasDirtyDocument(sourceUri)) { throw new Error('Save unsaved documents before copying'); }
                    try { await fs.promises.copyFile(sourceUri.fsPath, newFilePath, fs.constants.COPYFILE_EXCL); }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw error; }
                        throw new Error(`Copy failed; destination may be incomplete: ${error}`);
                    }
                    try {
                        if (destinationRootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                        if (!sourceIsActive()) { throw new Error('Source scratch directory changed'); }
                        assertInsideRoot(sourceRoot, sourceUri.fsPath, sourceRootIdentity);
                        assertInsideRoot(destinationRoot, path.dirname(newFilePath), destinationRootIdentity);
                        const current = await fs.promises.lstat(sourceUri.fsPath);
                        if (!sourceIsActive() || destinationRootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                        if (!current.isFile() || !sameFile(original, current)) { throw new Error('Source changed during copying'); }
                        if (hasDirtyDocument(sourceUri)) { throw new Error('Source has unsaved changes'); }
                    } catch (error) {
                        throw new Error(`Copy completed, but source or paths changed; check the destination: ${error}`);
                    }
                    vscode.window.showInformationMessage(`File ${path.basename(sourceUri.fsPath)} successfully pasted to ${newFilePath}`);
                    break;
                }
                case ActionFile.CUT:
                    if (hasDirtyDocument(sourceUri)) { throw new Error('Save unsaved documents before moving'); }
                    await moveFileWithEditors(sourceUri.fsPath, newFilePath, () => {
                        if (destinationRootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                        if (!sourceIsActive()) { throw new Error('Source scratch directory changed'); }
                        assertInsideRoot(sourceRoot, sourceUri.fsPath, sourceRootIdentity);
                        assertInsideRoot(destinationRoot, path.dirname(newFilePath), destinationRootIdentity);
                        if (hasDirtyDocument(sourceUri)) { throw new Error('Save unsaved documents before moving'); }
                    }, sourceIdentity);
                    vscode.window.showInformationMessage(`File ${path.basename(sourceUri.fsPath)} successfully moved to ${newFilePath}`);
                    break;
                default:
                    vscode.window.showErrorMessage(`Error while pasting the file.`);
            }
        } catch (error) {
            Scratches.refreshViews(this);
            this.ui.error(`Error while pasting the file: ${error}`);
            return;
        }

        if (copiedFileUri === sourceUri && copiedFileRoot === sourceRoot && copiedFileIdentity === sourceIdentity && actionWithFile === action) {
            copiedFileUri = null;
            copiedFileRoot = null;
            copiedRootIdentity = undefined;
            copiedFileIdentity = undefined;
            copiedSourceIsActive = undefined;
            actionWithFile = null;
        }
        Scratches.refreshViews(this);
    }

    private async pasteBatch(batch: NonNullable<typeof copiedBatch>, element: FileItem | null, rootVersion: number,
        drop = false, cancellation?: vscode.CancellationToken): Promise<void> {
        const root = this.rootPath;
        const rootIdentity = this.rootIdentity;
        const target = drop ? element : element ?? this.selectItem;
        const folder = target ? (target.type === vscode.FileType.Directory ? target.uri.fsPath : path.dirname(target.uri.fsPath)) : root;
        const failed: typeof batch.entries = [];
        const errors: string[] = [];
        let copied = 0;
        for (const entry of batch.entries) {
            try {
                const validate = () => {
                    if (cancellation?.isCancellationRequested) { throw new Error('Move cancelled'); }
                    if (rootVersion !== this.rootVersion || !batch.isActive()) { throw new Error('Scratch directory changed'); }
                    assertInsideRoot(batch.root, entry.uri.fsPath, batch.rootIdentity);
                    assertInsideRoot(root, folder, rootIdentity);
                    if (hasDirtyDocument(entry.uri)) { throw new Error('Save unsaved documents before copying or moving'); }
                };
                validate();
                const destination = path.join(folder, path.basename(entry.uri.fsPath));
                if (entry.type === vscode.FileType.Directory) {
                    const relative = path.relative(entry.uri.fsPath, folder);
                    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
                        throw new Error('Cannot copy or move a folder into itself');
                    }
                    const current = selectedItemIdentity(batch.root, entry, batch.rootIdentity);
                    if (!sameIdentity(entry.identity, current)) { throw new Error('Selected item was replaced'); }
                    if (batch.action === ActionFile.CUT) {
                        validate();
                        await renameInEditor(entry.uri, vscode.Uri.file(destination));
                    } else {
                        await this.copyDirectory(entry.uri.fsPath, destination, validate, (source, target) => {
                            assertInsideRoot(batch.root, source, batch.rootIdentity);
                            assertInsideRoot(root, path.dirname(target), rootIdentity);
                        });
                    }
                } else if (batch.action === ActionFile.CUT) {
                    await moveFileWithEditors(entry.uri.fsPath, destination, validate, entry.identity);
                } else {
                    const original = await fs.promises.lstat(entry.uri.fsPath);
                    assertExpectedSource(original, entry.identity);
                    validate();
                    try { await fs.promises.copyFile(entry.uri.fsPath, destination, fs.constants.COPYFILE_EXCL); }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw error; }
                        throw new Error(`Copy failed; destination may be incomplete: ${error}`);
                    }
                    validate();
                    const current = await fs.promises.lstat(entry.uri.fsPath);
                    validate();
                    if (!sameFile(original, current)) { throw new Error('Source changed during copying'); }
                }
                copied++;
            } catch (error) { failed.push(entry); errors.push(`${path.basename(entry.uri.fsPath)}: ${error}`); }
        }
        if (copiedBatch === batch) {
            if (failed.length) { batch.entries = failed; }
            else {
                copiedBatch = undefined;
                copiedFileUri = null; copiedFileRoot = null; copiedRootIdentity = undefined;
                copiedFileIdentity = undefined; copiedSourceIsActive = undefined; actionWithFile = null;
            }
        }
        Scratches.refreshViews(this);
        if (errors.length) { this.ui.warn(`Completed ${copied} items; ${errors.length} failed. Check destinations before retrying: ${errors.join('; ')}`); }
        else { vscode.window.showInformationMessage(`Completed ${copied} items.`); }
    }

    private async copyDirectory(source: string, destination: string, validate: () => void,
        validatePaths: (source: string, destination: string) => void): Promise<void> {
        const original = await fs.promises.lstat(source);
        if (!original.isDirectory()) { throw new Error('Source is not a regular directory'); }
        validate();
        validatePaths(source, destination);
        await fs.promises.mkdir(destination);
        validatePaths(source, path.join(destination, '__directory_check__'));
        const children = await fs.promises.readdir(source);
        for (const name of children) {
            validate();
            const child = path.join(source, name);
            const target = path.join(destination, name);
            validatePaths(child, target);
            const stat = await fs.promises.lstat(child);
            if (stat.isSymbolicLink()) { throw new Error('Symbolic links inside folders are not supported'); }
            if (stat.isDirectory()) { await this.copyDirectory(child, target, validate, validatePaths); }
            else if (stat.isFile()) {
                if (hasDirtyDocument(vscode.Uri.file(child))) { throw new Error('Save unsaved documents before copying'); }
                await fs.promises.copyFile(child, target, fs.constants.COPYFILE_EXCL);
                const current = await fs.promises.lstat(child);
                validate();
                if (!sameFile(stat, current) || hasDirtyDocument(vscode.Uri.file(child))) { throw new Error('Source changed during copying'); }
            } else { throw new Error('Only regular files and directories are supported'); }
        }
        const current = await fs.promises.lstat(source);
        validate();
        validatePaths(source, path.join(destination, '__directory_check__'));
        if (!current.isDirectory() || !sameFile(original, current)) { throw new Error('Source folder changed during copying'); }
    }

    private async pasteSystemFiles(paths: string[], element: FileItem | null, rootVersion: number,
        drop = false, cancellation?: vscode.CancellationToken): Promise<void> {
        if (!paths.length) { this.ui.error(drop ? 'The drop does not contain supported local files.' : 'The system clipboard does not contain files.'); return; }
        if (paths.length > 100) { this.ui.error('Too many files (maximum 100).'); return; }
        const root = this.rootPath;
        const identity = this.rootIdentity;
        const target = drop ? element : element ?? this.selectItem;
        const folder = target ? (target.type === vscode.FileType.Directory ? target.uri.fsPath : path.dirname(target.uri.fsPath)) : root;
        const failures: string[] = [];
        let copied = 0;
        for (const source of paths) {
            try {
                if (cancellation?.isCancellationRequested) { throw new Error('Import cancelled'); }
                if (rootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                if (!path.isAbsolute(source) || source.includes('\0')) { throw new Error('Invalid source path'); }
                assertInsideRoot(root, folder, identity);
                const sourceUri = vscode.Uri.file(source);
                if (hasDirtyDocument(sourceUri)) { throw new Error('Save unsaved documents before copying'); }
                const original = await fs.promises.lstat(source);
                if (!original.isFile() && !original.isDirectory()) { throw new Error('Only regular files and folders are supported'); }
                if (cancellation?.isCancellationRequested) { throw new Error('Import cancelled'); }
                if (rootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                assertInsideRoot(root, folder, identity);
                if (hasDirtyDocument(sourceUri)) { throw new Error('Save unsaved documents before copying'); }
                const destination = path.join(folder, path.basename(source));
                if (original.isDirectory()) {
                    const relative = path.relative(source, folder);
                    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
                        throw new Error('Cannot copy a folder into itself');
                    }
                    const validate = () => {
                        if (cancellation?.isCancellationRequested) { throw new Error('Import cancelled'); }
                        if (rootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                        assertInsideRoot(source, source, original);
                        assertInsideRoot(root, folder, identity);
                        if (hasDirtyDocument(sourceUri)) { throw new Error('Save unsaved documents before copying'); }
                    };
                    await this.copyDirectory(source, destination, validate, (child, targetPath) => {
                        assertInsideRoot(source, child, original);
                        assertInsideRoot(root, path.dirname(targetPath), identity);
                    });
                } else {
                    try { await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL); }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw error; }
                        throw new Error(`Copy failed; destination may be incomplete: ${error}`);
                    }
                }
                const current = await fs.promises.lstat(source);
                if (rootVersion !== this.rootVersion || !sameFile(original, current) || hasDirtyDocument(sourceUri)) {
                    throw new Error('Copy created, but source or destination may have changed; check both files');
                }
                assertInsideRoot(root, folder, identity);
                copied++;
            } catch (error) { failures.push(`${path.basename(source)}: ${error}`); }
        }
        Scratches.refreshViews(this);
        if (failures.length) { this.ui.warn(`Copied ${copied} files; ${failures.length} failed. Check destinations before retrying: ${failures.join('; ')}`); }
        else { vscode.window.showInformationMessage(`Copied ${copied} items${drop ? ' from drop' : ' from the system clipboard'}.`); }
    }

    /**
     * Copies the file path of the specified file item to the clipboard.
     * 
     * @param {FileItem} element - The file item whose path will be copied.
     */
    async copyPath(element: FileItem | null) {
        element = element ?? this.selectItem;
        if (!element) { this.ui.error('No item selected'); return; }
        try {
            assertInsideRoot(this.rootPath, element.uri.fsPath, this.rootIdentity);
            await this.ui.copyText(element.uri.fsPath);
        } catch (error) { this.ui.error(`Could not copy path: ${error}`); }
    }

    /**
     * Refreshes the file tree to reflect any changes made.
     */
    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    async searchContent(): Promise<void> {
        const root = this.rootPath;
        const identity = this.rootIdentity;
        const version = this.rootVersion;
        if (!root || !identity) { this.ui.error('Scratch directory is unavailable.'); return; }
        const query = await this.ui.input({ prompt: 'Search text in this view (case-insensitive, literal)', ignoreFocusOut: true });
        if (!query) { return; }
        const validateRoot = () => {
            if (version !== this.rootVersion) { throw new Error('Scratch directory changed'); }
            assertInsideRoot(root, root, identity);
        };
        try {
            const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                title: 'Searching scratch files', cancellable: true }, async (_progress, token) =>
                searchTextFiles(root, query, validateRoot, file => assertInsideRoot(root, file, identity),
                    file => hasDirtyDocument(vscode.Uri.file(file)), () => token.isCancellationRequested));
            if (result.cancelled) { return; }
            validateRoot();
            if (result.skipped || result.truncated) {
                this.ui.warn(`Search skipped ${result.skipped} items${result.truncated ? ' or reached a search limit' : ''}.`);
            }
            if (!result.matches.length) { vscode.window.showInformationMessage('No matching scratch files found.'); return; }
            const selected = await vscode.window.showQuickPick(result.matches.map(match => ({
                label: `${path.relative(root, match.filePath)}:${match.line + 1}`,
                description: match.preview,
                match,
            })), { placeHolder: 'Select a matching file' });
            if (!selected) { return; }
            validateRoot();
            assertInsideRoot(root, selected.match.filePath, identity);
            const current = await fs.promises.lstat(selected.match.filePath);
            validateRoot();
            assertInsideRoot(root, selected.match.filePath, identity);
            if (!current.isFile() || !sameFile(selected.match.snapshot, current) || hasDirtyDocument(vscode.Uri.file(selected.match.filePath))) {
                throw new Error('File changed since the search; search again');
            }
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selected.match.filePath));
            const editor = await vscode.window.showTextDocument(document);
            const position = new vscode.Position(selected.match.line, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
        } catch (error) { this.ui.error(`Could not search scratch files: ${error}`); }
    }

    /**
     * Creates a new scratch file with a timestamp-based name.
     * 
     * The function prompts the user to select a file extension and 
     * generates a default file name based on the current date and time. 
     * It then allows the user to edit the file name before creating 
     * an empty file at the specified location. After the file is created, 
     * it opens the document in the editor and refreshes the file list.
     */
    async newScratchFile() {
        const rootPath = this.rootPath;
        const rootVersion = this.rootVersion;
        if (!rootPath) { this.ui.error('Scratch directory is unavailable.'); return; }
        let selectedType: string | undefined;
        try { selectedType = await this.fileExtenrionsManager.selectFileExtension(); }
        catch (error) { vscode.window.showErrorMessage(`Could not load or update extensions: ${error}`); return; }
        if (rootVersion !== this.rootVersion) { vscode.window.showWarningMessage('Scratch directory changed; operation cancelled.'); return; }

        if (selectedType) {
            const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
            const fileName = `${timestamp}${selectedType}`;

            const fileNameNew = await this.ui.input({
                placeHolder: "Input file name",
                value: fileName,
                valueSelection: [0, timestamp.length],
            });

            if (fileNameNew) {
                if (rootVersion !== this.rootVersion) { vscode.window.showWarningMessage('Scratch directory changed; operation cancelled.'); return; }
                if (!validName(fileNameNew)) {
                    vscode.window.showErrorMessage("Enter a file name without path separators.");
                    return;
                }
                const filePath = path.join(rootPath, fileNameNew);
                try { assertInsideRoot(rootPath, rootPath, this.rootIdentity); fs.writeFileSync(filePath, "", { flag: 'wx' }); }
                catch (error) { this.ui.error(`Could not create file: ${error}`); return; }

                Scratches.refreshViews(this);

                if (fileNameNew.endsWith(selectedType)) {
                    try { await this.fileExtenrionsManager.recordUsage(selectedType); }
                    catch (error) { this.ui.warn(`File created, but extension usage could not be saved: ${error}`); }
                }

                try { await this.ui.openFile(filePath); }
                catch (error) { this.ui.error(`File created, but could not be opened: ${error}`); }
            }
        }
    }

    /**
     * Creates a new folder in the specified location.
     * 
     * If an element is provided, it determines the folder path based 
     * on the type of the element. If no element is provided, it defaults 
     * to the currently selected item. The user is prompted to enter 
     * a folder name, and if a folder with that name does not already 
     * exist, it creates the folder. If the folder exists, an information 
     * message is displayed to the user.
     * 
     * @param {FileItem | null} element - The file item representing the 
     * location where the new folder should be created. If null, uses 
     * the currently selected item.
     */
    async newFolder(element: FileItem | null) {
        const rootVersion = this.rootVersion;
        let newFilePath = this.rootPath;
        if (!element) {
            element = this.selectItem;
        }

        if (element) {
            newFilePath = element.type === vscode.FileType.Directory ?
                element.uri.fsPath :
                path.resolve(element.uri.fsPath, '..');
        }

        const folderNameNew = await vscode.window.showInputBox({
            placeHolder: "Input folder name",
            value: "",
        });

        if (folderNameNew) {
            if (rootVersion !== this.rootVersion) { vscode.window.showWarningMessage('Scratch directory changed; operation cancelled.'); return; }
            if (!validName(folderNameNew)) { vscode.window.showErrorMessage("Enter a folder name without path separators."); return; }
            newFilePath = path.join(newFilePath, folderNameNew);
            try {
                assertInsideRoot(this.rootPath, path.dirname(newFilePath), this.rootIdentity);
                fs.mkdirSync(newFilePath);
                Scratches.refreshViews(this);
            } catch (error) { vscode.window.showErrorMessage(`Could not create folder: ${error}`); }
        }
    }

    /**
     * Renames a file or folder based on user input.
     * 
     * This function prompts the user to enter a new name for the selected
     * file or folder. If the new name is provided, it renames the file 
     * or folder and displays a confirmation message. Unsaved documents must
     * be saved before renaming.
     * 
     * @param {FileItem} element - The file item that represents the file 
     * or folder to be renamed.
     */
    async rename(element: FileItem | null) {
        const rootVersion = this.rootVersion;
        element = element ?? this.selectItem;
        if (!element) { vscode.window.showErrorMessage('No file selected!'); return; }
        let identity: FileIdentity;
        try { identity = selectedItemIdentity(this.rootPath, element, this.rootIdentity); }
        catch (error) { this.ui.error(`Could not rename: ${error}`); return; }
        const fileName = await this.ui.input({
            prompt: "Enter new file name",
            value: path.basename(element.uri.fsPath),
        });
        const oldPath = element.uri.fsPath;

        if (fileName) {
            if (rootVersion !== this.rootVersion) { vscode.window.showWarningMessage('Scratch directory changed; operation cancelled.'); return; }
            if (fileName === path.basename(oldPath)) { return; }
            if (!validName(fileName)) { vscode.window.showErrorMessage("Enter a name without path separators."); return; }
            const newFilePath = path.join(path.dirname(oldPath), fileName);
            try {
                if (!sameIdentity(identity, selectedItemIdentity(this.rootPath, element, this.rootIdentity))) {
                    throw new Error('Selected item was replaced; select it again');
                }
                await renameInEditor(element.uri, vscode.Uri.file(newFilePath));
            } catch (error) { this.ui.error(`Could not rename: ${error}`); return; }
            vscode.window.showInformationMessage(`Renamed: ${oldPath} to ${newFilePath}`);
            Scratches.refreshViews(this);

        }
    }

    /**
     * Deletes a file or folder after user confirmation.
     * 
     * This function checks if an element is provided. If not, it uses
     * the currently selected item. It prompts the user for confirmation 
     * before deleting the specified file or folder. If confirmed, the 
     * function moves the item to the system trash. Unsaved documents must
     * be saved before deletion.
     * 
     * @param {FileItem | null} element - The file item to delete. If null, 
     * it defaults to the currently selected item.
     */
    async delete(element: FileItem | null, selection?: readonly FileItem[]) {
        const rootVersion = this.rootVersion;
        const selected = this.commandSelection(element, selection);
        if (selected.length > 1) { await this.deleteSelected(selected, rootVersion); return; }
        if (selected.length === 1) { element = selected[0]; }
        if (!element) {
            element = this.selectItem;
        }

        if (!element) {
            vscode.window.showErrorMessage("No file selected!");
            return;
        }

        let identity: FileIdentity;
        try { identity = selectedItemIdentity(this.rootPath, element, this.rootIdentity); }
        catch (error) { this.ui.error(`Could not delete: ${error}`); return; }

        const confirm = await this.ui.confirm(
            `Are you sure you want to delete ${element.uri.fsPath}?`,
            "Yes",
            "No"
        );

        if (confirm === "Yes") {
            if (rootVersion !== this.rootVersion) { vscode.window.showWarningMessage('Scratch directory changed; operation cancelled.'); return; }
            try {
                if (!sameIdentity(identity, selectedItemIdentity(this.rootPath, element, this.rootIdentity))) {
                    throw new Error('Selected item was replaced; select it again');
                }
            } catch (error) { this.ui.error(`Could not delete: ${error}`); return; }
            if (hasDirtyDocument(element.uri)) {
                this.ui.error('Save unsaved documents before deleting.');
                return;
            }
            try {
                const options = { recursive: element.type === vscode.FileType.Directory, useTrash: true };
                if (this.ui.deleteItem) { await this.ui.deleteItem(element.uri, options); }
                else { await vscode.workspace.fs.delete(element.uri, options); }
            } catch (error) {
                vscode.window.showErrorMessage(`Could not delete: ${error}`);
                return;
            }
            vscode.window.showInformationMessage(`Moved to trash: ${element.uri.fsPath}`);
            this.updateSelection([]);
            Scratches.refreshViews(this);
        }
    }

    private async deleteSelected(selection: readonly FileItem[], rootVersion: number): Promise<void> {
        if (selection.length > 100) { this.ui.error('Select no more than 100 items'); return; }
        const unique = [...new Map(selection.map(item => [item.uri.fsPath, item])).values()];
        const items = unique.filter(item => !unique.some(parent => {
            if (parent === item || parent.type !== vscode.FileType.Directory) { return false; }
            const relative = path.relative(parent.uri.fsPath, item.uri.fsPath);
            return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        }));
        let identities: FileIdentity[];
        try { identities = items.map(item => selectedItemIdentity(this.rootPath, item, this.rootIdentity)); }
        catch (error) { this.ui.error(`Could not select items for deletion: ${error}`); return; }
        const confirm = await this.ui.confirm(`Move ${items.length} selected items to the system trash?`, 'Yes', 'No');
        if (confirm !== 'Yes') { return; }
        let moved = 0;
        const failures: string[] = [];
        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            try {
                if (rootVersion !== this.rootVersion) { throw new Error('Scratch directory changed'); }
                if (!sameIdentity(identities[index], selectedItemIdentity(this.rootPath, item, this.rootIdentity))) {
                    throw new Error('Selected item was replaced');
                }
                if (hasDirtyDocument(item.uri)) { throw new Error('Save unsaved documents before deleting'); }
                const options = { recursive: item.type === vscode.FileType.Directory, useTrash: true };
                if (this.ui.deleteItem) { await this.ui.deleteItem(item.uri, options); }
                else { await vscode.workspace.fs.delete(item.uri, options); }
                moved++;
            } catch (error) { failures.push(`${path.basename(item.uri.fsPath)}: ${error}`); }
        }
        this.updateSelection([]);
        Scratches.refreshViews(this);
        if (failures.length) { this.ui.warn(`Moved ${moved} items to trash; ${failures.length} failed: ${failures.join('; ')}`); }
        else { vscode.window.showInformationMessage(`Moved ${moved} items to trash.`); }
    }

    /**
     * Retrieves the children of the specified directory or the root path.
     * 
     * This function reads the contents of the provided directory or the 
     * root path if no element is specified. It returns a promise that 
     * resolves to an array of `FileItem` objects representing the files 
     * and directories within the specified path.
     * 
     * @param {FileItem} [element] - An optional `FileItem` representing 
     * the directory whose children should be retrieved. If not provided, 
     * the root path is used.
     * @returns {Thenable<FileItem[]>} A promise that resolves to an array 
     * of `FileItem` objects.
     */
    async getChildren(element?: FileItem): Promise<FileItem[]> {
        const rootVersion = this.rootVersion;
        let dirPath = this.rootPath;
        if (element) {
            dirPath = element.uri.fsPath;
        }

        let files: fs.Dirent[];
        try {
            assertInsideRoot(this.rootPath, dirPath, this.rootIdentity);
            files = await fs.promises.readdir(dirPath, { withFileTypes: true });
            if (rootVersion !== this.rootVersion) { return []; }
            assertInsideRoot(this.rootPath, dirPath, this.rootIdentity);
        } catch (error) {
            vscode.window.showErrorMessage(`Could not read directory: ${error}`);
            return [];
        }
        if (rootVersion !== this.rootVersion) { return []; }
        return files.flatMap((file) => {
                const filePath = path.join(dirPath, file.name);
                if (file.isSymbolicLink()) { return []; }
                const type = file.isFile() ? vscode.FileType.File
                    : file.isDirectory() ? vscode.FileType.Directory
                            : vscode.FileType.Unknown;

                return [{ uri: vscode.Uri.file(filePath), type: type, name: file.name }];
            }).sort(
                (a, b) => {
                    const specialCharsRegex = /^[^a-zA-Z0-9]/;
                    const digitRegex = /^\d/;

                    if (a.type !== b.type) {
                        if (a.type < b.type) {
                            return 1;
                        }
                        else {
                            return -1;
                        }
                    }

                    const aIsSpecialChar = specialCharsRegex.test(a.name);
                    const bIsSpecialChar = specialCharsRegex.test(a.name);
                    if (aIsSpecialChar && !bIsSpecialChar) {
                        return -1;
                    }
                    if (!aIsSpecialChar && bIsSpecialChar) {
                        return 1;
                    }

                    const aIsDigit = digitRegex.test(a.name);
                    const bIsDigit = digitRegex.test(b.name);

                    if (aIsDigit && !bIsDigit) {
                        return 1;
                    }
                    if (!aIsDigit && bIsDigit) {
                        return -1;
                    }
                    if (aIsDigit && bIsDigit) {
                        return b.name.localeCompare(a.name);
                    }

                    return a.name.localeCompare(b.name);
                }
            );
    }

    /**
     * Creates a tree item representation of the specified file or directory.
     * 
     * This function generates a `TreeItem` for the provided `FileItem`. 
     * If the item is a directory, it is marked as collapsible; otherwise, 
     * it is not. The tree item includes a command for opening the file 
     * in the editor.
     * 
     * @param {FileItem} element - The `FileItem` to create a tree item for.
     * @returns {vscode.TreeItem} A `TreeItem` representing the specified file or directory.
     */
    getTreeItem(element: FileItem): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.uri,
            element.type === vscode.FileType.Directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        treeItem.command = {
            command: `${this.viewId}.openScratchFile`,
            title: "Open File",
            arguments: [element],
        };
        treeItem.contextValue = element.type === vscode.FileType.Directory ? 'directory' : 'file';
        if (element.type === vscode.FileType.File && this.cleanupPreview?.paths.has(element.uri.fsPath)) {
            treeItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
            treeItem.tooltip = 'Selected for cleanup; files with unsaved changes, conflicts or other errors may be skipped.';
        }
        return treeItem;
    }

    /**
     * Cleans up resources when the provider is disposed.
     * 
     * This function disposes of any resources associated with the tree data 
     * event subscription to prevent memory leaks.
     */
    dispose(): void {
        this.rootVersion++;
        this.cleanupPreview = undefined;
        invalidateStaleCompareSource();
        this.updateSelection([]);
        this._onDidChangeTreeData.dispose();
    }
}


interface FileItem {
    uri: vscode.Uri;
    type: vscode.FileType;
}
