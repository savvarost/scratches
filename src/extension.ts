import * as vscode from 'vscode';
import { Scratches } from './scratches';
import * as fs from 'fs';
import * as os from 'os';
import { expandHomeDirectory } from './directory';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.window.registerTreeDataProvider('viewsWelcome', {
		getTreeItem: () => new vscode.TreeItem(''),
		getChildren: () => [],
	}));
	context.subscriptions.push(vscode.commands.registerCommand("scratches.setRootPath", () => setRootPath()));
	context.subscriptions.push(vscode.commands.registerCommand('scratches.swapCompareSides', () => Scratches.swapComparison()));
	context.subscriptions.push(vscode.commands.registerCommand('scratches.compareWithClipboard', () => Scratches.compareActiveWithClipboard()));
	context.subscriptions.push(vscode.commands.registerCommand('scratches.selectWorkspaceFolder', () => Scratches.selectWorkspaceFolder(context)));

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('scratches.path')) {
				handleConfigChange(context);
			}
		})
	);
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => Scratches.createView(context)));
	context.subscriptions.push({ dispose: () => Scratches.dispose() });
	Scratches.createView(context);
}

async function _setRootPath(rootPath: string | undefined): Promise<boolean> {
	rootPath = rootPath === undefined ? undefined : expandHomeDirectory(rootPath);
	try {
		if (!rootPath || !fs.lstatSync(rootPath).isDirectory()) { throw new Error('Not a directory or is a symbolic link'); }
		const config = vscode.workspace.getConfiguration("scratches");
		await config.update("path", rootPath, vscode.ConfigurationTarget.Global);
		return true;
	} catch (error) {
		vscode.window.showErrorMessage(`Could not set scratch directory: ${error}`);
		return false;
	}
}

async function setRootPath() {
	const options = {
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true,
		defaultUri: vscode.Uri.file(os.homedir()),
	};
	const folderUri = await vscode.window.showOpenDialog(options);

	if (folderUri && folderUri.length > 0) {
		const rootPath = folderUri[0].fsPath;
		await _setRootPath(rootPath);
	}
}

function handleConfigChange(context: vscode.ExtensionContext) {
	Scratches.createView(context);
}

export function deactivate() { }
