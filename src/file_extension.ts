import * as fs from 'fs';
import * as vscode from 'vscode';
import * as directory from './directory';

const ADD_EXTENSION_LABEL = 'New extension';
const REMOVE_EXTENSION_LABEL = 'Remove extension';

function normalizeExtension(extension: string): string {
    const trimmed = extension.trim();
    if (!trimmed) {
        return '';
    }

    return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

export class FileExtensionsManager {
    private fileExtensions: string[] = [];

    constructor() {
        this.load();
    }

    private load(): void {
        this.fileExtensions = directory.getFileExtensions();
    }

    getFileExtensionQuickPickItems(withAction = true): vscode.QuickPickItem[] {
        const quickPickItems: vscode.QuickPickItem[] = [
            { label: 'Extension', kind: vscode.QuickPickItemKind.Separator },
            ...this.fileExtensions.map((fileExtension) => ({ label: fileExtension })),
        ];

        if (withAction) {
            quickPickItems.push(
                { label: 'Action', kind: vscode.QuickPickItemKind.Separator },
                { label: ADD_EXTENSION_LABEL },
                { label: REMOVE_EXTENSION_LABEL },
            );
        }

        return quickPickItems;
    }

    public async selectFileExtension(): Promise<string | undefined> {
        const selection = await vscode.window.showQuickPick(this.getFileExtensionQuickPickItems(), {
            placeHolder: 'Select an extension',
        });

        if (!selection?.label) {
            return undefined;
        }

        if (selection.label === ADD_EXTENSION_LABEL) {
            const newExtension = await vscode.window.showInputBox({ placeHolder: 'Input extension name' });
            if (!newExtension) {
                return undefined;
            }

            const normalizedExtension = normalizeExtension(newExtension);
            if (!normalizedExtension) {
                vscode.window.showInformationMessage('Extension name cannot be empty.');
                return undefined;
            }

            this.addFileExtension(normalizedExtension);
            return normalizedExtension;
        }

        if (selection.label === REMOVE_EXTENSION_LABEL) {
            const removeSelection = await vscode.window.showQuickPick(this.getFileExtensionQuickPickItems(false), {
                placeHolder: 'Select an extension to remove',
            });

            if (removeSelection?.label) {
                this.removeFileExtension(removeSelection.label);
            }

            return undefined;
        }

        return selection.label;
    }

    private addFileExtension(fileExtension: string): void {
        if (!this.fileExtensions.includes(fileExtension)) {
            this.fileExtensions.push(fileExtension);
            this.fileExtensions.sort((a, b) => a.localeCompare(b));
            this.updateFileExtensions();
            vscode.window.showInformationMessage(`Extension "${fileExtension}" added successfully!`);
            return;
        }

        vscode.window.showInformationMessage(`Extension "${fileExtension}" already exists!`);
    }

    private removeFileExtension(fileExtension: string): void {
        const index = this.fileExtensions.indexOf(fileExtension);
        if (index === -1) {
            vscode.window.showInformationMessage(`Extension "${fileExtension}" not found!`);
            return;
        }

        this.fileExtensions.splice(index, 1);
        this.updateFileExtensions();
        vscode.window.showInformationMessage(`Extension "${fileExtension}" successfully removed!`);
    }

    private updateFileExtensions(): void {
        const recentFileTypesPath = directory.getFileExtensionsPath();
        fs.writeFileSync(recentFileTypesPath, JSON.stringify(this.fileExtensions, null, 2));
    }
}
