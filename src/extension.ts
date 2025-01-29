import * as vscode from 'vscode';
import { Scratches } from './scratches';
import * as fs from 'fs';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
	Scratches.createView(context);

	vscode.commands.registerCommand("scratches.setRootPath", () => setRootPath());

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('scratches.path')) {
				handleConfigChange(context);
			}
		})
	);
}

function _setRootPath(rootPath: string | undefined): boolean {
	const homeDir = os.homedir();

	rootPath = rootPath?.replace("~", homeDir);
	if (rootPath && fs.existsSync(rootPath)) {
		const config = vscode.workspace.getConfiguration("scratches");
		config.update("path", rootPath, vscode.ConfigurationTarget.Global, true);
		return true;
	} else {
		vscode.window.showInformationMessage("The path to the location where the \"scratch\" files are stored is incorrect.");
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
		_setRootPath(rootPath);
	}
}

function handleConfigChange(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration("scratches");
	const path = config.get<string>('path');

	if (path) {
		if (_setRootPath(path)) {
			Scratches.createView(context);
		}
	}
}

export function deactivate() { }
