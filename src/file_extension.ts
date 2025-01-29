
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as directory from './directory';
import path from 'path';


/**
 * Manages file extensions for the VS Code environment.
 */
export class FileExtensionsManager {
    private fileExtensions: string[] = [];

    /**
     * Initializes the FileExtensionsManager and loads existing extensions.
     */
    constructor() {
        this.load();
    }

    /**
     * Loads file extensions from the JSON file.
     */
    private load() {
        const vscodePath = path.join(directory.getRootScratchesDirectory(), ".vscode");
        directory.ensureDirectoryExists(vscodePath);

        this.fileExtensions = directory.getFileExtensions();
    }

    /**
     * Generates QuickPick items for file extensions.
     * @param withAction - Indicates whether to include action items (e.g., add/remove).
     * @returns {vscode.QuickPickItem[]} An array of QuickPick items for file extensions.
     */
    getFileExtensionQuickPickItems(withAction: boolean = true): vscode.QuickPickItem[] {
        const quickPickItems: vscode.QuickPickItem[] = [
            { label: 'Extension', kind: vscode.QuickPickItemKind.Separator }
        ];

        for (const fileExtension of this.fileExtensions) {
            quickPickItems.push({ label: fileExtension });
        }

        if (withAction) {
            quickPickItems.push(
                { label: 'Action', kind: vscode.QuickPickItemKind.Separator },
                { label: "New extension" },
                { label: "Remove extension" }
            );
        }

        return quickPickItems;
    }

    /**
     * Prompts the user to select a file extension, allowing for addition or removal of extensions.
     * @returns {Promise<string | undefined>} The selected file extension or undefined if canceled.
     */
    public async selectFileExtension(): Promise<string | undefined> {
        const selection = await vscode.window.showQuickPick(this.getFileExtensionQuickPickItems(), { placeHolder: 'Select an extension' });

        if (!selection?.label) {
            return;
        }

        if (selection.label === "New extension") {
            const newExtension: string | undefined = await vscode.window.showInputBox({ placeHolder: "Input extension name" });
            if (newExtension) {
                this.addFileExtension(newExtension);
                return newExtension;
            }
        }

        if (selection.label === "Remove extension") {
            const removeSelection = await vscode.window.showQuickPick(this.getFileExtensionQuickPickItems(false), { placeHolder: 'Select an extension to remove' });
            if (removeSelection?.label) {
                this.removeFileExtension(removeSelection.label);
                return;
            }
        }

        return selection.label;
    }

    /**
     * Adds a new file extension to the list and updates the JSON file.
     * @param fileExtension - The file extension to add.
     */
    private addFileExtension(fileExtension: string) {
        if (!this.fileExtensions.includes(fileExtension)) {
            this.fileExtensions.push(fileExtension);
            this.updateFileExtensions();
            vscode.window.showInformationMessage(`Extension "${fileExtension}" added successfully!`);
        } else {
            vscode.window.showInformationMessage(`Extension "${fileExtension}" already exists!`);
        }
    }

    /**
     * Removes a file extension from the list and updates the JSON file.
     * @param fileExtension - The file extension to remove.
     */
    private removeFileExtension(fileExtension: string) {
        const index = this.fileExtensions.indexOf(fileExtension);
        if (index === -1) {
            vscode.window.showInformationMessage(`Extension "${fileExtension}" not found!`);
        } else {
            this.fileExtensions.splice(index, 1);
            this.updateFileExtensions();
            vscode.window.showInformationMessage(`Extension "${fileExtension}" successfully removed!`);
        }
    }

    /**
     * Writes the current list of file extensions to the JSON file.
     */
    private updateFileExtensions() {
        const recentFileTypesPath = directory.getFileExtensionsPath();
        fs.writeFileSync(recentFileTypesPath, JSON.stringify(this.fileExtensions, null, 2));
    }
}