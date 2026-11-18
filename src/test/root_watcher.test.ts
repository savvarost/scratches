import * as assert from 'assert';
import * as vscode from 'vscode';
import { RootWatcher } from '../root_watcher';

class FakeWatcher implements vscode.FileSystemWatcher {
    readonly ignoreCreateEvents = false;
    readonly ignoreChangeEvents = false;
    readonly ignoreDeleteEvents = false;
    readonly create = new vscode.EventEmitter<vscode.Uri>();
    readonly change = new vscode.EventEmitter<vscode.Uri>();
    readonly remove = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidCreate = this.create.event;
    readonly onDidChange = this.change.event;
    readonly onDidDelete = this.remove.event;
    disposed = false;
    dispose(): void { this.disposed = true; this.create.dispose(); this.change.dispose(); this.remove.dispose(); }
}

suite('Root watcher', () => {
    test('coalesces events, reuses the same root and cancels old updates on replacement and disposal', async () => {
        const created: FakeWatcher[] = [];
        let refreshes = 0;
        const watcher = new RootWatcher(() => { refreshes++; }, 20, () => {
            const current = new FakeWatcher();
            created.push(current);
            return current;
        });
        const wait = () => new Promise<void>(resolve => setTimeout(resolve, 60));
        const uri = vscode.Uri.file('/tmp/example');
        try {
            watcher.setRoot('/one', { dev: 1, ino: 1 });
            watcher.setRoot('/one', { dev: 1, ino: 1 });
            assert.strictEqual(created.length, 1);
            created[0].create.fire(uri);
            created[0].change.fire(uri);
            created[0].remove.fire(uri);
            await wait();
            assert.strictEqual(refreshes, 1);
            created[0].create.fire(uri);
            watcher.setRoot('/one', { dev: 1, ino: 2 });
            assert.strictEqual(created[0].disposed, true);
            await wait();
            assert.strictEqual(refreshes, 1);
            created[1].change.fire(uri);
            await wait();
            assert.strictEqual(refreshes, 2);
            created[1].change.fire(uri);
            watcher.setRoot('');
            await wait();
            assert.strictEqual(created[1].disposed, true);
            assert.strictEqual(refreshes, 2);
            watcher.setRoot('/two', { dev: 1, ino: 3 });
            created[2].change.fire(uri);
            watcher.dispose();
            await wait();
            assert.strictEqual(created[2].disposed, true);
            assert.strictEqual(refreshes, 2);
        } finally { watcher.dispose(); }
    });
});
