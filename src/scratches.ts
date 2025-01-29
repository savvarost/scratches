
import * as path from "path";
import * as vscode from 'vscode';
import * as directory from './directory';
import * as fs from "fs";
import * as fileExtension from "./file_extension";

let scratchesDirectory: string;
let copiedFileUri: vscode.Uri | null;
let actionWithFile: ActionFile | null = null;

export enum ActionFile {
    COPY = 0,
    CUT = 1
}


export class Scratches {
    public static createView(context: vscode.ExtensionContext) {
        scratchesDirectory = directory.getRootScratchesDirectory();
        if (fs.existsSync(scratchesDirectory)) {
            directory.ensureDirectoryExists(scratchesDirectory);

            const fileExtenrionsManager: fileExtension.FileExtensionsManager = new fileExtension.FileExtensionsManager();

            const projectDirectory = directory.getDirectoryProject();
            if (projectDirectory !== null) {
                DirectoryViewer.initDirectoryViewer(context, "sectionProjectFiles", projectDirectory, fileExtenrionsManager);
            }

            DirectoryViewer.initDirectoryViewer(context, "sectionSharedFiles", directory.getDirectoryShare(), fileExtenrionsManager);
            DirectoryViewer.initDirectoryViewer(context, "sectionAllFiles", scratchesDirectory, fileExtenrionsManager);
        }
        else {
            vscode.window.showErrorMessage(`Error configuration "Scratches: Path". Directory "${scratchesDirectory}" not found!`);
        }
    }
}


export class DirectoryViewer implements vscode.TreeDataProvider<FileItem> {
    public selectItem: FileItem | null = null;
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
        directory.ensureDirectoryExists(directoryPath);

        const directoryViewer = new DirectoryViewer(context, directoryPath, viewId, fileExtenrionsManager);
        vscode.window.createTreeView(viewId, { treeDataProvider: directoryViewer, showCollapseAll: true });

        vscode.commands.registerCommand(viewId + ".refresh", () => directoryViewer.refresh());
        vscode.commands.registerCommand(viewId + ".newScratchFile", () => directoryViewer.newScratchFile());
        vscode.commands.registerCommand(viewId + ".newFolder", (node: FileItem) => directoryViewer.newFolder(node));
        vscode.commands.registerCommand(viewId + ".delete", (node: FileItem) => directoryViewer.delete(node));
        vscode.commands.registerCommand(viewId + ".openScratchFile", (node: FileItem) => directoryViewer.open(node));
        vscode.commands.registerCommand(viewId + ".rename", (node: FileItem) => directoryViewer.rename(node));
        vscode.commands.registerCommand(viewId + ".copy", (node: FileItem) => directoryViewer.copy(node));
        vscode.commands.registerCommand(viewId + ".cut", (node: FileItem) => directoryViewer.cut(node));
        vscode.commands.registerCommand(viewId + ".paste", (node: FileItem) => directoryViewer.paste(node));
        vscode.commands.registerCommand(viewId + ".copyPath", (node: FileItem) => directoryViewer.copyPath(node));
        vscode.commands.registerCommand(viewId + ".clear", () => directoryViewer.clear());
    }

    constructor(
        public readonly context: vscode.ExtensionContext,
        public readonly rootPath: string,
        public readonly viewId: string,
        public readonly fileExtenrionsManager: fileExtension.FileExtensionsManager,
    ) { }

    /**
     * Opens the specified file item in a new text document.
     * 
     * If the provided element is a file, it opens the file in the editor while preserving focus.
     * 
     * @param {FileItem} element - The file item to open.
     */
    open(element: FileItem) {
        this.selectItem = element;

        if (element.type === vscode.FileType.File) {
            vscode.window.showTextDocument(element.uri, { "preserveFocus": true });
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
        const proposed_date = new Date(Date.now());
        proposed_date.setDate(proposed_date.getDate() - 30);

        const userStringDate = await vscode.window.showInputBox({
            prompt: "Specify a date. Files older than this will be moved to the 'trash' directory. Format: 'YYYY-MM-DD'.",
            value: proposed_date.toISOString().split('T')[0],
        });

        if (!userStringDate) { return; }

        if (!userStringDate.match(/\d{4}-\d{2}-\d{2}/)) {
            vscode.window.showInformationMessage(`Invalid date format: ${userStringDate}!`);
            return;
        }

        const userDate = new Date(userStringDate);
        if (isNaN(userDate.getTime())) {
            vscode.window.showInformationMessage(`Invalid date format: ${userStringDate}!`);
            return;
        }


        const files = fs.readdirSync(this.rootPath);
        const filesToMove = files.filter(fileName => {
            if (!fileName) { return false; }

            const filePath = path.join(this.rootPath, fileName);
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) { return false; }

            const dateMatch = fileName.match(/^(\d{4})(\d{2})(\d{2})-\d{6}/);
            if (dateMatch) {
                const fileDate = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
                return fileDate <= userDate && stat.mtime <= userDate;
            }
            return false;
        });

        if (filesToMove.length === 0) {
            vscode.window.showInformationMessage(`Nothing to move to "trash"`);
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Move ${filesToMove.length} files to the "trash"?`,
            "Yes",
            "No"
        );

        if (confirm === "Yes") {
            const trashPath = path.join(this.rootPath, 'trash');
            directory.ensureDirectoryExists(trashPath);
            filesToMove.forEach(fileName => {
                fs.renameSync(path.join(this.rootPath, fileName), path.join(trashPath, fileName));
            });
            vscode.window.showInformationMessage(`Successfully moved ${filesToMove.length} files to "trash"`);
            this.refresh();
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
    _copyCut(element: FileItem | null) {
        if (!element) {
            element = this.selectItem;
        }

        if (!element) {
            vscode.window.showInformationMessage(`No file selected.`);
            return;
        }

        if (element.type === vscode.FileType.Directory) {
            vscode.window.showInformationMessage(`Copying directories is not supported.`);
            return;
        }

        copiedFileUri = element.uri;
    }

    /**
     * Copies the specified file item, or the currently selected item if none is provided.
     * 
     * This function calls the internal copy/cut function and sets the action to COPY.
     * 
     * @param {FileItem | null} element - The file item to copy. If null, the currently selected item is used.
     */
    copy(element: FileItem | null) {
        this._copyCut(element);
        actionWithFile = ActionFile.COPY;
    }

    /**
     * Cuts the specified file item, or the currently selected item if none is provided.
     * 
     * This function calls the internal copy/cut function and sets the action to CUT.
     * 
     * @param {FileItem | null} element - The file item to cut. If null, the currently selected item is used.
     */
    cut(element: FileItem | null) {
        this._copyCut(element);
        actionWithFile = ActionFile.CUT;
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
        if (!copiedFileUri) {
            vscode.window.showInformationMessage(`Nothing was copied!`);
            return;
        }

        let newFilePath: string = this.rootPath;

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

        newFilePath = path.resolve(newFilePath, `${copiedFileUri.path.split('/').pop()}`);
        if (fs.existsSync(newFilePath)) {
            vscode.window.showInformationMessage(`A file named "${newFilePath}" already exists!`);
            return;
        }

        try {
            switch (actionWithFile) {
                case ActionFile.COPY:
                    fs.copyFileSync(copiedFileUri.fsPath, newFilePath);
                    vscode.window.showInformationMessage(`File ${copiedFileUri.path.split('/').pop()} successfully pasted to ${newFilePath}`);
                    break;
                case ActionFile.CUT:
                    fs.renameSync(copiedFileUri.fsPath, newFilePath);
                    vscode.window.showInformationMessage(`File ${copiedFileUri.path.split('/').pop()} successfully moved to ${newFilePath}`);
                    break;
                default:
                    vscode.window.showErrorMessage(`Error while pasting the file.`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error while pasting the file: ${error}`);
        }

        copiedFileUri = null;
        actionWithFile = null;
        this.refresh();
    }

    /**
     * Copies the file path of the specified file item to the clipboard.
     * 
     * @param {FileItem} element - The file item whose path will be copied.
     */
    copyPath(element: FileItem) {
        vscode.env.clipboard.writeText(element.uri.fsPath);
    }

    /**
     * Refreshes the file tree to reflect any changes made.
     */
    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
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
        const selectedType = await this.fileExtenrionsManager.selectFileExtension();

        if (selectedType) {
            const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
            const fileName = `${timestamp}${selectedType}`;

            const fileNameNew = await vscode.window.showInputBox({
                placeHolder: "Input file name",
                value: fileName,
                valueSelection: [0, timestamp.length],
            });

            if (fileNameNew) {
                const filePath = path.join(this.rootPath, fileNameNew);
                fs.writeFileSync(filePath, "");

                vscode.workspace.openTextDocument(filePath).then((doc) => {
                    vscode.window.showTextDocument(doc);
                });

                this.refresh();
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
            newFilePath = path.join(newFilePath, folderNameNew);
            if (!fs.existsSync(newFilePath)) {
                fs.mkdirSync(newFilePath, { recursive: true });
                this.refresh();
            } else {
                vscode.window.showInformationMessage(`A folder named "${folderNameNew}" already exists`);
            }
        }
    }

    /**
     * Renames a file or folder based on user input.
     * 
     * This function prompts the user to enter a new name for the selected
     * file or folder. If the new name is provided, it renames the file 
     * or folder and displays a confirmation message. It also closes any 
     * open editor tabs associated with the file being renamed.
     * 
     * @param {FileItem} element - The file item that represents the file 
     * or folder to be renamed.
     */
    async rename(element: FileItem) {
        const fileName = await vscode.window.showInputBox({
            prompt: "Enter new file name",
        });
        const oldPath = element.uri.fsPath;

        if (fileName) {
            const newFilePath = path.join(path.dirname(oldPath), fileName);
            fs.renameSync(oldPath, newFilePath);
            vscode.window.showInformationMessage(`Renamed: ${oldPath} to ${newFilePath}`);
            this.refresh();

            const documents = vscode.workspace.textDocuments.filter(td => td.fileName === oldPath);

            for (const doc of documents) {
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            }

            // TODO нужно научиться переименовывать и во вкладках наименование, пока просто закрываем,
            // сделать чтобы работало так же как и в vscode при переименовании
        }
    }

    /**
     * Deletes a file or folder after user confirmation.
     * 
     * This function checks if an element is provided. If not, it uses
     * the currently selected item. It prompts the user for confirmation 
     * before deleting the specified file or folder. If confirmed, the 
     * function deletes the item and closes any open editor tabs associated 
     * with it.
     * 
     * @param {FileItem | null} element - The file item to delete. If null, 
     * it defaults to the currently selected item.
     */
    async delete(element: FileItem | null) {
        if (!element) {
            element = this.selectItem;
        }

        if (!element) {
            vscode.window.showErrorMessage("No file selected!");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${element.uri.fsPath}?`,
            "Yes",
            "No"
        );

        if (confirm === "Yes") {
            if (element.type === vscode.FileType.Directory) {
                fs.rmdirSync(element.uri.fsPath, { recursive: true });
                vscode.window.showInformationMessage(`Deleted folder: ${element.uri.fsPath}`);
            } else {
                fs.unlinkSync(element.uri.fsPath);
                vscode.window.showInformationMessage(`Deleted file: ${element.uri.fsPath}`);

                const documents = vscode.workspace.textDocuments.filter(td => td.fileName === element.uri.fsPath);

                for (const doc of documents) {
                    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                }
            }

            this.selectItem = null;
            this.refresh();
        }
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
    getChildren(element?: FileItem): Thenable<FileItem[]> {
        let dirPath = this.rootPath;
        if (element) {
            dirPath = element.uri.fsPath;
        }

        const files = fs.readdirSync(dirPath);
        return Promise.resolve(
            files.map((file) => {
                const filePath = path.join(dirPath, file);
                const stat = fs.statSync(filePath);
                const type = stat.isFile() ? vscode.FileType.File
                    : stat.isDirectory() ? vscode.FileType.Directory
                        : stat.isSymbolicLink() ? vscode.FileType.SymbolicLink
                            : vscode.FileType.Unknown;

                return { uri: vscode.Uri.file(filePath), type: type, name: file };
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
            )
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
        return treeItem;
    }

    /**
     * Cleans up resources when the provider is disposed.
     * 
     * This function disposes of any resources associated with the tree data 
     * event subscription to prevent memory leaks.
     */
    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}


interface FileItem {
    uri: vscode.Uri;
    type: vscode.FileType;
}
