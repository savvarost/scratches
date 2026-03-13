import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as directory from './directory';
import { FileExtensionsManager } from './file_extension';

type ClipboardState = {
    fileUri: vscode.Uri;
    action: ActionFile;
};

const DATE_PREFIX_REGEX = /^\d{8}/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const SPECIAL_CHAR_REGEX = /^[^a-zA-Z0-9]/;
const DIGIT_REGEX = /^\d/;

let clipboardState: ClipboardState | null = null;

export enum ActionFile {
    COPY = 0,
    CUT = 1,
}

interface SectionConfig {
    viewId: string;
    directoryPath: string;
}

interface FileItem {
    uri: vscode.Uri;
    type: vscode.FileType;
}

export class Scratches {
    public static createView(context: vscode.ExtensionContext): void {
        const scratchesDirectory = directory.getRootScratchesDirectory();
        if (!fs.existsSync(scratchesDirectory)) {
            vscode.window.showErrorMessage(`Error configuration "Scratches: Path". Directory "${scratchesDirectory}" not found!`);
            return;
        }

        const fileExtensionsManager = new FileExtensionsManager();

        const sections: SectionConfig[] = [
            { viewId: 'sectionSharedFiles', directoryPath: directory.getDirectoryShare() },
            { viewId: 'sectionAllFiles', directoryPath: scratchesDirectory },
        ];

        const projectDirectory = directory.getDirectoryProject();
        if (projectDirectory) {
            sections.unshift({ viewId: 'sectionProjectFiles', directoryPath: projectDirectory });
        }

        for (const section of sections) {
            DirectoryViewer.initDirectoryViewer(context, section, fileExtensionsManager);
        }
    }
}

export class DirectoryViewer implements vscode.TreeDataProvider<FileItem>, vscode.Disposable {
    private static readonly COMMAND_SUFFIXES = [
        'refresh',
        'newScratchFile',
        'newFolder',
        'delete',
        'openScratchFile',
        'rename',
        'copy',
        'cut',
        'paste',
        'copyPath',
        'clear',
    ] as const;

    public selectedItem: FileItem | null = null;
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FileItem | undefined | null | void>();
    private readonly disposables: vscode.Disposable[] = [];

    public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    public static initDirectoryViewer(
        context: vscode.ExtensionContext,
        section: SectionConfig,
        fileExtensionsManager: FileExtensionsManager,
    ): void {
        directory.ensureDirectoryExists(section.directoryPath);

        const viewer = new DirectoryViewer(context, section.directoryPath, section.viewId, fileExtensionsManager);
        context.subscriptions.push(viewer);

        const treeView = vscode.window.createTreeView(section.viewId, {
            treeDataProvider: viewer,
            showCollapseAll: true,
        });

        viewer.trackDisposable(treeView);
        viewer.registerCommands();
    }

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly rootPath: string,
        private readonly viewId: string,
        private readonly fileExtensionsManager: FileExtensionsManager,
    ) {}

    private registerCommands(): void {
        for (const suffix of DirectoryViewer.COMMAND_SUFFIXES) {
            const commandId = `${this.viewId}.${suffix}`;
            const callback = this.getCommandHandler(suffix);
            this.trackDisposable(vscode.commands.registerCommand(commandId, callback));
        }
    }

    private getCommandHandler(suffix: (typeof DirectoryViewer.COMMAND_SUFFIXES)[number]): (...args: FileItem[]) => unknown {
        switch (suffix) {
            case 'refresh':
                return () => this.refresh();
            case 'newScratchFile':
                return () => this.newScratchFile();
            case 'newFolder':
                return (node?: FileItem) => this.newFolder(node ?? null);
            case 'delete':
                return (node?: FileItem) => this.delete(node ?? null);
            case 'openScratchFile':
                return (node: FileItem) => this.open(node);
            case 'rename':
                return (node: FileItem) => this.rename(node);
            case 'copy':
                return (node?: FileItem) => this.copy(node ?? null);
            case 'cut':
                return (node?: FileItem) => this.cut(node ?? null);
            case 'paste':
                return (node?: FileItem) => this.paste(node ?? null);
            case 'copyPath':
                return (node: FileItem) => this.copyPath(node);
            case 'clear':
                return () => this.clear();
            default:
                return () => undefined;
        }
    }

    open(element: FileItem): void {
        this.selectedItem = element;

        if (element.type === vscode.FileType.File) {
            void vscode.window.showTextDocument(element.uri, { preserveFocus: true });
        }
    }

    async clear(): Promise<void> {
        const proposedDate = new Date(Date.now());
        proposedDate.setDate(proposedDate.getDate() - 30);

        const userStringDate = await vscode.window.showInputBox({
            prompt: 'Specify a date. Files older than this will be moved to the "trash" directory. Format: "YYYY-MM-DD".',
            value: proposedDate.toISOString().split('T')[0],
        });

        if (!userStringDate) {
            return;
        }

        if (!ISO_DATE_REGEX.test(userStringDate)) {
            vscode.window.showInformationMessage(`Invalid date format: ${userStringDate}!`);
            return;
        }

        const userDate = new Date(userStringDate);
        if (Number.isNaN(userDate.getTime())) {
            vscode.window.showInformationMessage(`Invalid date: ${userStringDate}!`);
            return;
        }

        const rootFiles = fs.readdirSync(this.rootPath).filter((name) => {
            const datePrefix = name.match(DATE_PREFIX_REGEX)?.[0];
            if (!datePrefix) {
                return false;
            }

            const fileDate = new Date(`${datePrefix.slice(0, 4)}-${datePrefix.slice(4, 6)}-${datePrefix.slice(6, 8)}`);
            return !Number.isNaN(fileDate.getTime()) && fileDate < userDate;
        });

        if (rootFiles.length === 0) {
            vscode.window.showInformationMessage(`No files older than ${userStringDate} found in ${this.rootPath}`);
            return;
        }

        const confirmed = await vscode.window.showWarningMessage(
            `Move ${rootFiles.length} files to "trash"?`,
            { modal: true },
            'Yes',
        );

        if (confirmed !== 'Yes') {
            return;
        }

        const trashPath = path.join(this.rootPath, 'trash');
        directory.ensureDirectoryExists(trashPath);

        for (const fileName of rootFiles) {
            fs.renameSync(path.join(this.rootPath, fileName), path.join(trashPath, fileName));
        }

        vscode.window.showInformationMessage(`Successfully moved ${rootFiles.length} files to "trash"`);
        this.refresh();
    }

    private resolveSelectedElement(element: FileItem | null): FileItem | null {
        return element ?? this.selectedItem;
    }

    private copyOrCut(element: FileItem | null, action: ActionFile): void {
        const selected = this.resolveSelectedElement(element);
        if (!selected) {
            vscode.window.showInformationMessage('No file selected.');
            return;
        }

        if (selected.type === vscode.FileType.Directory) {
            vscode.window.showInformationMessage('Copying directories is not supported.');
            return;
        }

        clipboardState = {
            fileUri: selected.uri,
            action,
        };
    }

    copy(element: FileItem | null): void {
        this.copyOrCut(element, ActionFile.COPY);
    }

    cut(element: FileItem | null): void {
        this.copyOrCut(element, ActionFile.CUT);
    }

    async paste(element: FileItem | null): Promise<void> {
        if (!clipboardState) {
            vscode.window.showInformationMessage('Nothing was copied!');
            return;
        }

        const destinationDirectory = this.resolveDestinationDirectory(this.resolveSelectedElement(element));
        const fileName = path.basename(clipboardState.fileUri.fsPath);
        const newFilePath = path.join(destinationDirectory, fileName);

        if (fs.existsSync(newFilePath)) {
            vscode.window.showInformationMessage(`A file named "${newFilePath}" already exists!`);
            return;
        }

        try {
            if (clipboardState.action === ActionFile.COPY) {
                fs.copyFileSync(clipboardState.fileUri.fsPath, newFilePath);
                vscode.window.showInformationMessage(`File ${fileName} successfully pasted to ${newFilePath}`);
            } else {
                fs.renameSync(clipboardState.fileUri.fsPath, newFilePath);
                vscode.window.showInformationMessage(`File ${fileName} successfully moved to ${newFilePath}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error while pasting the file: ${String(error)}`);
        }

        clipboardState = null;
        this.refresh();
    }

    private resolveDestinationDirectory(element: FileItem | null): string {
        if (!element) {
            return this.rootPath;
        }

        if (element.type === vscode.FileType.Directory) {
            return element.uri.fsPath;
        }

        return path.dirname(element.uri.fsPath);
    }

    copyPath(element: FileItem): void {
        void vscode.env.clipboard.writeText(element.uri.fsPath);
    }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    async newScratchFile(): Promise<void> {
        const selectedType = await this.fileExtensionsManager.selectFileExtension();
        if (!selectedType) {
            return;
        }

        const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        const fileName = `${timestamp}${selectedType}`;

        const fileNameNew = await vscode.window.showInputBox({
            placeHolder: 'Input file name',
            value: fileName,
            valueSelection: [0, timestamp.length],
        });

        if (!fileNameNew) {
            return;
        }

        const filePath = path.join(this.rootPath, fileNameNew);
        fs.writeFileSync(filePath, '');

        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
        this.refresh();
    }

    async newFolder(element: FileItem | null): Promise<void> {
        const basePath = this.resolveDestinationDirectory(this.resolveSelectedElement(element));
        const folderNameNew = await vscode.window.showInputBox({
            placeHolder: 'Input folder name',
            value: '',
        });

        if (!folderNameNew) {
            return;
        }

        const newFolderPath = path.join(basePath, folderNameNew);
        if (fs.existsSync(newFolderPath)) {
            vscode.window.showInformationMessage(`A folder named "${folderNameNew}" already exists`);
            return;
        }

        fs.mkdirSync(newFolderPath, { recursive: true });
        this.refresh();
    }

    async rename(element: FileItem): Promise<void> {
        const oldPath = element.uri.fsPath;
        const fileName = await vscode.window.showInputBox({
            prompt: 'Enter new file name',
            value: path.basename(oldPath),
        });

        if (!fileName) {
            return;
        }

        const newFilePath = path.join(path.dirname(oldPath), fileName);
        fs.renameSync(oldPath, newFilePath);
        vscode.window.showInformationMessage(`Renamed: ${oldPath} to ${newFilePath}`);
        this.refresh();

        await this.closeOpenDocument(oldPath);
    }

    async delete(element: FileItem | null): Promise<void> {
        const selected = this.resolveSelectedElement(element);

        if (!selected) {
            vscode.window.showErrorMessage('No file selected!');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${selected.uri.fsPath}?`,
            'Yes',
            'No',
        );

        if (confirm !== 'Yes') {
            return;
        }

        if (selected.type === vscode.FileType.Directory) {
            fs.rmSync(selected.uri.fsPath, { recursive: true, force: true });
            vscode.window.showInformationMessage(`Deleted folder: ${selected.uri.fsPath}`);
        } else {
            fs.unlinkSync(selected.uri.fsPath);
            vscode.window.showInformationMessage(`Deleted file: ${selected.uri.fsPath}`);
            await this.closeOpenDocument(selected.uri.fsPath);
        }

        this.selectedItem = null;
        this.refresh();
    }

    private async closeOpenDocument(filePath: string): Promise<void> {
        const documents = vscode.workspace.textDocuments.filter((td) => td.fileName === filePath);

        for (const doc of documents) {
            await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
    }

    getChildren(element?: FileItem): Thenable<FileItem[]> {
        const dirPath = element?.uri.fsPath ?? this.rootPath;
        const files = fs.readdirSync(dirPath);

        const items = files
            .map((fileName) => {
                const filePath = path.join(dirPath, fileName);
                const stat = fs.lstatSync(filePath);
                const type = stat.isDirectory()
                    ? vscode.FileType.Directory
                    : stat.isFile()
                        ? vscode.FileType.File
                        : stat.isSymbolicLink()
                            ? vscode.FileType.SymbolicLink
                            : vscode.FileType.Unknown;

                return { uri: vscode.Uri.file(filePath), type };
            })
            .sort(compareFileItems);

        return Promise.resolve(items);
    }

    getTreeItem(element: FileItem): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.uri,
            element.type === vscode.FileType.Directory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
        );

        treeItem.command = {
            command: `${this.viewId}.openScratchFile`,
            title: 'Open File',
            arguments: [element],
        };
        treeItem.contextValue = element.type === vscode.FileType.Directory ? 'directory' : 'file';

        return treeItem;
    }

    private trackDisposable(disposable: vscode.Disposable): void {
        this.disposables.push(disposable);
        this.context.subscriptions.push(disposable);
    }

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();

        for (const disposable of this.disposables) {
            disposable.dispose();
        }

        this.disposables.length = 0;
    }
}

export function compareFileItems(a: FileItem, b: FileItem): number {
    if (a.type !== b.type) {
        return a.type === vscode.FileType.Directory ? -1 : 1;
    }

    const aName = path.basename(a.uri.fsPath);
    const bName = path.basename(b.uri.fsPath);

    const aIsSpecial = SPECIAL_CHAR_REGEX.test(aName);
    const bIsSpecial = SPECIAL_CHAR_REGEX.test(bName);

    if (aIsSpecial !== bIsSpecial) {
        return aIsSpecial ? -1 : 1;
    }

    const aIsDigit = DIGIT_REGEX.test(aName);
    const bIsDigit = DIGIT_REGEX.test(bName);

    if (aIsDigit !== bIsDigit) {
        return aIsDigit ? 1 : -1;
    }

    if (aIsDigit && bIsDigit) {
        return bName.localeCompare(aName);
    }

    return aName.localeCompare(bName);
}
