import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { Scratches } from './scratches';

const SCRATCHES_CONFIG = 'scratches';
const PATH_KEY = 'path';

export function activate(context: vscode.ExtensionContext): void {
    Scratches.createView(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('scratches.setRootPath', () => setRootPath()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${SCRATCHES_CONFIG}.${PATH_KEY}`)) {
                handleConfigChange(context);
            }
        }),
    );
}

function normalizePath(rootPath: string | undefined): string | undefined {
    if (!rootPath) {
        return undefined;
    }

    return rootPath.replace('~', os.homedir());
}

function updateRootPath(rootPath: string | undefined): boolean {
    const normalizedPath = normalizePath(rootPath);
    if (!normalizedPath || !fs.existsSync(normalizedPath)) {
        vscode.window.showInformationMessage('The path to the location where the "scratch" files are stored is incorrect.');
        return false;
    }

    const config = vscode.workspace.getConfiguration(SCRATCHES_CONFIG);
    void config.update(PATH_KEY, normalizedPath, vscode.ConfigurationTarget.Global, true);
    return true;
}

async function setRootPath(): Promise<void> {
    const folderUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: false,
        canSelectFolders: true,
        defaultUri: vscode.Uri.file(os.homedir()),
    });

    if (folderUri?.[0]) {
        updateRootPath(folderUri[0].fsPath);
    }
}

function handleConfigChange(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration(SCRATCHES_CONFIG);
    const configuredPath = config.get<string>(PATH_KEY);

    if (updateRootPath(configuredPath)) {
        Scratches.createView(context);
    }
}

export function deactivate(): void {}
