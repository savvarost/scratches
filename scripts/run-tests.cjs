const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { randomUUID } = require('crypto');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const root = path.resolve(__dirname, '..');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'scratches-vscode-test-'));
    try {
        const userDir = path.join(profile, 'user-data');
        const settingsDir = path.join(userDir, 'User');
        await fs.mkdir(settingsDir, { recursive: true });
        await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({ 'workbench.localHistory.enabled': false }));
        const options = {
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(root, 'out', 'test', 'runner.js'),
            version: process.env.SCRATCHES_VSCODE_VERSION || '1.105.0',
            extensionTestsEnv: { SCRATCHES_TEST_TMPDIR: profile, SCRATCHES_TEST_FILE_PASTEBOARD: `org.scratches.tests.${randomUUID()}` },
            launchArgs: ['--disable-extensions', '--disable-workspace-trust',
                `--user-data-dir=${userDir}`, `--extensions-dir=${path.join(profile, 'extensions')}`],
        };
        if (process.env.SCRATCHES_VSCODE_EXECUTABLE) {
            options.vscodeExecutablePath = process.env.SCRATCHES_VSCODE_EXECUTABLE;
        }
        await runTests(options);
        const workspaceFolder = path.join(profile, 'workspace-one');
        const workspaceFile = path.join(profile, 'test.code-workspace');
        await fs.mkdir(workspaceFolder);
        await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspaceFolder }] }));
        await runTests({ ...options,
            extensionTestsEnv: { ...options.extensionTestsEnv, SCRATCHES_WORKSPACE_TEST: '1' },
            launchArgs: [...options.launchArgs, workspaceFile],
        });
        const secondFolder = path.join(profile, 'workspace-two');
        const storage = path.join(profile, 'workspace-storage');
        await fs.mkdir(secondFolder);
        await fs.mkdir(storage);
        await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({
            'workbench.localHistory.enabled': false, 'scratches.path': storage,
        }));
        const reopenOptions = { ...options,
            launchArgs: [...options.launchArgs, workspaceFile],
            extensionTestsEnv: { ...options.extensionTestsEnv, SCRATCHES_REOPEN_STORAGE: storage,
                SCRATCHES_REOPEN_FIRST: workspaceFolder, SCRATCHES_REOPEN_SECOND: secondFolder },
        };
        await runTests({ ...reopenOptions,
            extensionTestsEnv: { ...reopenOptions.extensionTestsEnv, SCRATCHES_REOPEN_STAGE: 'first' },
        });
        await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: secondFolder }] }));
        await runTests({ ...reopenOptions,
            extensionTestsEnv: { ...reopenOptions.extensionTestsEnv, SCRATCHES_REOPEN_STAGE: 'second' },
        });
    } finally {
        try { await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
        catch (error) { console.error(`Could not remove test profile ${profile}:`, error); process.exitCode = 1; }
    }
}

main().catch(error => {
    console.error('Extension tests failed:', error);
    process.exitCode = 1;
});
