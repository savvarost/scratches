import path from 'path';
import * as vscode from 'vscode';
import * as os from "os";
import * as fs from "fs";

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
        vscode.window.showErrorMessage("No workspace folder opened.");
        return null;
    }

    const projectName = path.basename(workspaceFolder.uri.fsPath);
    return path.join(getRootScratchesDirectory(), projectName);
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
 * Gets the path to the VS Code directory within the root scratches directory.
 * @returns {string} The path to the VS Code directory.
 */
export function getVsCodePath(): string {
    return path.join(getRootScratchesDirectory(), '.vscode');
}

/**
 * Gets the path to the recent file extensions JSON file within the VS Code directory.
 * @returns {string} The path to the recent file extensions JSON file.
 */
export function getFileExtensionsPath(): string {
    return path.join(getVsCodePath(), '.recentFileExtension.json');
}

/**
 * Retrieves the list of recent file extensions from the JSON file.
 * If the file does not exist, it creates it with an empty array.
 * @returns {string[]} An array of recent file extensions.
 */
export function getFileExtensions(): string[] {
    ensureDirectoryExists(getVsCodePath());

    const fileExtensionsPath = getFileExtensionsPath();
    if (!fs.existsSync(fileExtensionsPath)) {
        fs.writeFileSync(fileExtensionsPath, JSON.stringify([], null, 2));
    }

    const data = fs.readFileSync(fileExtensionsPath, 'utf8');
    return JSON.parse(data);
}




/**
 * Retrieves the root directory to work with, based on configuration.
 * 
 * If the directory is not configured, the home directory is returned as 
 * a fallback. An error message is displayed if the configuration is 
 * missing.
 *
 * @returns {string} The path to the root directory.
 */
export function getRootScratchesDirectory(): string {
    const config = vscode.workspace.getConfiguration("scratches");
    const homeDir = os.homedir();

    let directory = config.get<string>("path") ?? '';

    if (!directory) {
        vscode.window.showErrorMessage("Scratches directory is not configured.");
        return homeDir;
    }

    return directory.replace("~", homeDir);
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
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to ensure directory exists: ${message}`);
        throw error;
    }
}
