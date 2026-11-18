import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as directory from './directory';

const storageKey = 'fileExtensions.v1';

interface ExtensionEntry {
    extension: string;
    uses: number;
}

function isEntry(value: unknown): value is ExtensionEntry {
    if (!value || typeof value !== 'object') { return false; }
    const entry = value as Record<string, unknown>;
    return typeof entry.extension === 'string' && entry.extension.length > 0 &&
        typeof entry.uses === 'number' && Number.isSafeInteger(entry.uses) && entry.uses >= 0;
}

export class FileExtensionsManager {
    private pending: Promise<void> = Promise.resolve();

    constructor(
        private readonly state: vscode.Memento,
        private readonly getRoot: () => string = directory.getRootScratchesDirectory,
    ) { }

    // Последовательные обновления исключают потерю счётчиков в пределах процесса.
    private async change<T>(operation: (entries: ExtensionEntry[]) => Promise<T>): Promise<T> {
        const result = this.pending.then(async () => operation(await this.load()));
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    private async load(): Promise<ExtensionEntry[]> {
        const stored = this.state.get<unknown>(storageKey);
        if (stored !== undefined) {
            if (!Array.isArray(stored) || !stored.every(isEntry) ||
                new Set(stored.map(entry => entry.extension)).size !== stored.length) {
                throw new Error('Invalid stored extensions list');
            }
            return stored.map(entry => ({ ...entry }));
        }

        const root = this.getRoot();
        const legacyDir = path.join(root, '.vscode');
        const legacyPath = path.join(legacyDir, '.recentFileExtension.json');
        let entries: ExtensionEntry[] = [];
        try {
            const dirStat = await fs.promises.lstat(legacyDir);
            if (!dirStat.isDirectory()) { throw new Error('Legacy settings directory is not a directory'); }
            const stat = await fs.promises.lstat(legacyPath);
            if (!stat.isFile()) { throw new Error('Legacy extensions list is not a regular file'); }
            const handle = await fs.promises.open(legacyPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
            try {
                const openedStat = await handle.stat();
                if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
                    throw new Error('Legacy extensions list changed during migration');
                }
                const legacy: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
                if (!Array.isArray(legacy) || !legacy.every(item => typeof item === 'string' && item.length > 0)) {
                    throw new Error('Invalid legacy extensions list');
                }
                entries = [...new Set(legacy)].map(extension => ({ extension, uses: 0 }));
            } finally { await handle.close(); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
        await this.state.update(storageKey, entries);
        return entries;
    }

    public async getFileExtensionQuickPickItems(withAction = true): Promise<vscode.QuickPickItem[]> {
        return this.change(async entries => {
            const items: vscode.QuickPickItem[] = [{ label: 'Extension', kind: vscode.QuickPickItemKind.Separator }];
            // Стабильная сортировка сохраняет исходный порядок при равной частоте.
            entries.sort((a, b) => b.uses - a.uses);
            items.push(...entries.map(entry => ({ label: entry.extension })));
            if (withAction) {
                items.push({ label: 'Action', kind: vscode.QuickPickItemKind.Separator },
                    { label: 'New extension' }, { label: 'Remove extension' });
            }
            return items;
        });
    }

    public async selectFileExtension(): Promise<string | undefined> {
        const selection = await vscode.window.showQuickPick(await this.getFileExtensionQuickPickItems(), { placeHolder: 'Select an extension' });
        if (!selection?.label) { return; }
        if (selection.label === 'New extension') {
            const extension = await vscode.window.showInputBox({ placeHolder: 'Input extension name' });
            if (!extension) { return; }
            await this.addFileExtension(extension);
            return extension;
        }
        if (selection.label === 'Remove extension') {
            const removed = await vscode.window.showQuickPick(await this.getFileExtensionQuickPickItems(false), { placeHolder: 'Select an extension to remove' });
            if (removed?.label) { await this.removeFileExtension(removed.label); }
            return;
        }
        return selection.label;
    }

    public async addFileExtension(extension: string): Promise<void> {
        await this.change(async entries => {
            if (entries.some(entry => entry.extension === extension)) { return; }
            entries.push({ extension, uses: 0 });
            await this.state.update(storageKey, entries);
        });
    }

    public async removeFileExtension(extension: string): Promise<void> {
        await this.change(async entries => {
            await this.state.update(storageKey, entries.filter(entry => entry.extension !== extension));
        });
    }

    public async recordUsage(extension: string): Promise<void> {
        await this.change(async entries => {
            const entry = entries.find(item => item.extension === extension);
            if (!entry) { return; }
            entry.uses = Math.min(entry.uses + 1, Number.MAX_SAFE_INTEGER);
            await this.state.update(storageKey, entries);
        });
    }
}
