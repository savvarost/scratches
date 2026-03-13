import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import * as vscode from 'vscode';

const SCRATCHES_CONFIG_KEY = 'scratches';
const SCRATCHES_PATH_KEY = 'path';
const SHARE_DIR_NAME = 'share';
const VSCODE_DIR_NAME = '.vscode';
const FILE_EXTENSIONS_FILE_NAME = '.recentFileExtension.json';

export function getDirectoryProject(): string | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder opened.');
        return null;
    }

    const projectName = path.basename(workspaceFolder.uri.fsPath);
    return path.join(getRootScratchesDirectory(), projectName);
}

export function getDirectoryShare(): string {
    const directoryShare = path.join(getRootScratchesDirectory(), SHARE_DIR_NAME);
    ensureDirectoryExists(directoryShare);
    return directoryShare;
}

export function getVsCodePath(): string {
    return path.join(getRootScratchesDirectory(), VSCODE_DIR_NAME);
}

export function getFileExtensionsPath(): string {
    return path.join(getVsCodePath(), FILE_EXTENSIONS_FILE_NAME);
}

export function getFileExtensions(): string[] {
    ensureDirectoryExists(getVsCodePath());

    const fileExtensionsPath = getFileExtensionsPath();
    if (!fs.existsSync(fileExtensionsPath)) {
        fs.writeFileSync(fileExtensionsPath, JSON.stringify([], null, 2));
        return [];
    }

    const data = fs.readFileSync(fileExtensionsPath, 'utf8');

    try {
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) {
            throw new Error('File extensions file must contain an array.');
        }

        return parsed.filter((value): value is string => typeof value === 'string');
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        vscode.window.showWarningMessage(`Failed to parse recent extensions file: ${message}`);
        fs.writeFileSync(fileExtensionsPath, JSON.stringify([], null, 2));
        return [];
    }
}

export function getRootScratchesDirectory(): string {
    const config = vscode.workspace.getConfiguration(SCRATCHES_CONFIG_KEY);
    const homeDir = os.homedir();

    const configuredPath = config.get<string>(SCRATCHES_PATH_KEY) ?? '';
    if (!configuredPath) {
        vscode.window.showErrorMessage('Scratches directory is not configured.');
        return homeDir;
    }

    return configuredPath.replace('~', homeDir);
}

export function ensureDirectoryExists(directory: string): void {
    try {
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to ensure directory exists: ${message}`);
        throw error;
    }
}
