import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as utils from "./utils";
import { FiletypesManager } from "./filetypes.manager";
import { window } from "vscode";

let scratchesDirectory: string;

async function createScratchFile(directoryViewer: DirectoryViewer, folder_name: string) {
  /**
   * Функция создания scratch-файла
   */
  var filetypesManager = new FiletypesManager();

  const selectedType = await filetypesManager.selectFiletype();

  if (selectedType) {
    // Формируем имя файла на основе текущей даты и времени
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const fileName = `${timestamp}${selectedType.ext}`;

    const fileNameNew = await window.showInputBox({
      placeHolder: "Input file name",
      value: fileName,
    });

    if (fileNameNew) {
      // Создаем директорию проекта, если она не существует
      const folderPath = path.join(utils.getscratchesDirectory(), folder_name);
      utils.ensureDirectoryExists(folderPath);

      const filePath = path.join(utils.getscratchesDirectory(), folder_name, fileNameNew);
      fs.writeFileSync(filePath, "");

      vscode.workspace.openTextDocument(filePath).then((doc) => {
        vscode.window.showTextDocument(doc);
      });

      directoryViewer.refresh();
    }
  }
}

async function createProjectScratchFile(directoryViewer: DirectoryViewer) {
  /**
   * Функция создания scratch-файла в отдельной директории соответствующей названию проекта
   */
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder opened.");
    return;
  }

  const projectName = path.basename(workspaceFolder.uri.fsPath);
  await createScratchFile(directoryViewer, projectName);
}

async function createTotalScratchFile(directoryViewer: DirectoryViewer) {
  /**
   * Функция создания scratch-файла в отдельной общей директории total
   */
  await createScratchFile(directoryViewer, "total");
}

export function activate(context: vscode.ExtensionContext) {
  scratchesDirectory = utils.getscratchesDirectory();
  utils.ensureDirectoryExists(scratchesDirectory);

  const directoryViewer = new DirectoryViewer(context, scratchesDirectory);
  vscode.window.registerTreeDataProvider("directoryViewer", directoryViewer);

  vscode.commands.registerCommand("directoryViewer.refreshEntry", () => directoryViewer.refresh());

  vscode.commands.registerCommand("directoryViewer.openFile", (resource) => {
    vscode.window.showTextDocument(resource);
  });

  context.subscriptions.push(
    directoryViewer,
    vscode.commands.registerCommand("scratches.createProjectScratchFile", () => createProjectScratchFile(directoryViewer)),
    vscode.commands.registerCommand("scratches.createTotalScratchFile", () => createTotalScratchFile(directoryViewer)),
    vscode.commands.registerCommand("extension.createFile", async (node: FileItem) => {
      const uri = await vscode.window.showInputBox({
        prompt: "Enter file name",
      });
      if (uri) {
        const filePath = path.join(node.resourceUri.fsPath, uri);
        fs.writeFileSync(filePath, "");
        vscode.window.showInformationMessage(`Created file: ${filePath}`);
        directoryViewer.refresh();
      }
    }),
    vscode.commands.registerCommand("extension.deleteFile", async (node: FileItem) => {
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete ${node.resourceUri.fsPath}?`,
        "Yes",
        "No"
      );
      if (confirm === "Yes") {
        fs.unlinkSync(node.resourceUri.fsPath);
        vscode.window.showInformationMessage(`Deleted file: ${node.resourceUri.fsPath}`);
        directoryViewer.refresh();
      }
    }),
    vscode.commands.registerCommand("extension.renameFile", async (node: FileItem) => {
      const uri = await vscode.window.showInputBox({
        prompt: "Enter new file name",
      });
      if (uri) {
        const newFilePath = path.join(path.dirname(node.resourceUri.fsPath), uri);
        fs.renameSync(node.resourceUri.fsPath, newFilePath);
        vscode.window.showInformationMessage(`Renamed file: ${node.resourceUri.fsPath} to ${newFilePath}`);
        directoryViewer.refresh();
      }
    }),
    vscode.commands.registerCommand("extension.moveFile", async (node: FileItem) => {
      const uri = await vscode.window.showInputBox({
        prompt: "Enter destination directory",
      });
      if (uri && fs.existsSync(uri)) {
        const newFilePath = path.join(uri, path.basename(node.resourceUri.fsPath));
        fs.renameSync(node.resourceUri.fsPath, newFilePath);
        vscode.window.showInformationMessage(`Moved file: ${node.resourceUri.fsPath} to ${newFilePath}`);
        directoryViewer.refresh();
      }
    }),
    vscode.commands.registerCommand("extension.copyFile", async (node: FileItem) => {
      const uri = await vscode.window.showInputBox({
        prompt: "Enter destination directory",
      });
      if (uri && fs.existsSync(uri)) {
        const newFilePath = path.join(uri, path.basename(node.resourceUri.fsPath));
        fs.copyFileSync(node.resourceUri.fsPath, newFilePath);
        vscode.window.showInformationMessage(`Copied file: ${node.resourceUri.fsPath} to ${newFilePath}`);
        directoryViewer.refresh();
      }
    }),
    vscode.commands.registerCommand("extension.cutFile", async (node: FileItem) => {
      const uri = await vscode.window.showInputBox({
        prompt: "Enter destination directory",
      });
      if (uri && fs.existsSync(uri)) {
        const newFilePath = path.join(uri, path.basename(node.resourceUri.fsPath));
        fs.renameSync(node.resourceUri.fsPath, newFilePath);
        vscode.window.showInformationMessage(`Moved file: ${node.resourceUri.fsPath} to ${newFilePath}`);
        directoryViewer.refresh();
      }
    })
  );
}

class DirectoryViewer implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<FileItem | null | undefined> = new vscode.EventEmitter<
    FileItem | null | undefined
  >();
  readonly onDidChangeTreeData: vscode.Event<FileItem | null | undefined> = this._onDidChangeTreeData.event;

  private rootPath: string;

  constructor(private context: vscode.ExtensionContext, rootPath: string) {
    this.rootPath = rootPath;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileItem): Thenable<FileItem[]> {
    if (element) {
      return Promise.resolve(this.getFilesAndDirectories(element.resourceUri.fsPath));
    } else {
      return Promise.resolve(this.getFilesAndDirectories(this.rootPath));
    }
  }

  private getFilesAndDirectories(dirPath: string): FileItem[] {
    const files = fs.readdirSync(dirPath);
    return files.map((file) => {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      return new FileItem(
        vscode.Uri.file(filePath),
        stat.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        stat.isDirectory() ? "directory" : "file"
      );
    });
  }

  dispose(): void {
    // Cleanup resources
    this._onDidChangeTreeData.dispose();
  }
}

class FileItem extends vscode.TreeItem {
  constructor(
    public readonly resourceUri: vscode.Uri,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string
  ) {
    super(resourceUri, collapsibleState);
    this.label = path.basename(this.resourceUri.fsPath);
    this.command = {
      command: "directoryViewer.openFile",
      title: "Open File",
      arguments: [this.resourceUri],
    };
  }
}

export function deactivate() {}
