import path from 'path';
import * as vscode from 'vscode';
import * as os from "os";
import * as fs from "fs";
import { createHash } from 'crypto';

export function getProjectStoragePath(root: string, workspaceUri: vscode.Uri): string {
    const projectName = (path.basename(workspaceUri.fsPath) || 'workspace').slice(0, 80);
    const hash = createHash('sha256').update(workspaceUri.toString()).digest('hex');
    return path.join(root, '.projects', `${projectName}-${hash}`);
}

export function ensureProjectStoragePath(root: string, workspaceUri: vscode.Uri): string {
    ensureDirectoryExists(path.join(root, '.projects'));
    const projectPath = getProjectStoragePath(root, workspaceUri);
    ensureDirectoryExists(projectPath);
    return projectPath;
}

/**
 * Retrieves the project directory based on the currently opened workspace.
 * 
 * If there is no workspace folder opened, an error message is displayed 
 * and null is returned.
 *
 * @returns {string | null} The path to the project directory, or null if 
 *                          no workspace folder is opened.
 */
export function getDirectoryProject(): string | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return null;
    }

    const root = getRootScratchesDirectory();
    return ensureProjectStoragePath(root, workspaceFolder.uri);
}
/**
 * Retrieves the share directory path within the root scratches directory.
 * 
 * The share directory is created if it does not already exist.
 * 
 * @returns {string} The path to the share directory.
 */
export function getDirectoryShare(): string {
    const directoryShare = path.join(getRootScratchesDirectory(), 'share');
    ensureDirectoryExists(directoryShare);
    return directoryShare;
}

/**
 * Retrieves the root directory to work with, based on configuration.
 * 
 * If the directory is not configured, an empty string is returned.
 *
 * @returns {string} The path to the root directory.
 */
export function getRootScratchesDirectory(): string {
    const config = vscode.workspace.getConfiguration("scratches");
    return expandHomeDirectory(config.get<string>("path") ?? '');
}

export function expandHomeDirectory(directory: string): string {
    if (directory === '~') { return os.homedir(); }
    if (directory.startsWith('~/') || (path.sep === '\\' && directory.startsWith('~\\'))) {
        return path.join(os.homedir(), directory.slice(2));
    }
    return directory;
}

/**
 * Ensures that the specified directory exists.
 * 
 * If the directory does not exist, it will be created along with any necessary 
 * parent directories.
 * 
 * @param {string} directory - The path to the directory that needs to be ensured.
 * 
 * @throws {Error} Throws an error if the directory cannot be created due to 
 *                 permission issues or other filesystem errors.
 */
export function ensureDirectoryExists(directory: string) {
    try {
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        if (!fs.lstatSync(directory).isDirectory()) {
            throw new Error(`Not a directory or is a symbolic link: ${directory}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to ensure directory exists: ${message}`);
        throw error;
    }
}
