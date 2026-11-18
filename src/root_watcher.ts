import * as vscode from 'vscode';

interface RootIdentity { dev: number; ino: number }
type WatcherFactory = (root: string) => vscode.FileSystemWatcher;

/** Один рекурсивный наблюдатель для всех деревьев расширения. */
export class RootWatcher implements vscode.Disposable {
    private watcher: vscode.FileSystemWatcher | undefined;
    private subscriptions: vscode.Disposable[] = [];
    private root = '';
    private identity: RootIdentity | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private generation = 0;

    constructor(private readonly refresh: () => void, private readonly delayMs = 150,
        private readonly factory: WatcherFactory = root =>
            vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'))) { }

    setRoot(root: string, identity?: RootIdentity): void {
        if (root && this.watcher && this.root === root && this.identity?.dev === identity?.dev &&
            this.identity?.ino === identity?.ino) { return; }
        this.stop();
        if (!root || !identity) { return; }
        const watcher = this.factory(root);
        this.watcher = watcher;
        this.root = root;
        this.identity = { dev: identity.dev, ino: identity.ino };
        const generation = this.generation;
        const schedule = () => {
            if (generation !== this.generation || this.timer) { return; }
            this.timer = setTimeout(() => {
                this.timer = undefined;
                if (generation === this.generation) { this.refresh(); }
            }, this.delayMs);
        };
        try {
            this.subscriptions.push(watcher.onDidCreate(schedule));
            this.subscriptions.push(watcher.onDidChange(schedule));
            this.subscriptions.push(watcher.onDidDelete(schedule));
        } catch (error) { this.stop(); throw error; }
    }

    private stop(): void {
        this.generation++;
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        for (const subscription of this.subscriptions.splice(0)) { subscription.dispose(); }
        this.watcher?.dispose();
        this.watcher = undefined;
        this.root = '';
        this.identity = undefined;
    }

    dispose(): void { this.stop(); }
}
