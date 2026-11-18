import * as fs from 'fs';
import * as path from 'path';

export async function run(): Promise<void> {
    const { default: Mocha } = await import('mocha');
    const mocha = new Mocha({ ui: 'tdd', color: true });
    const workspaceTest = process.env.SCRATCHES_WORKSPACE_TEST === '1';
    const reopenTest = Boolean(process.env.SCRATCHES_REOPEN_STAGE);
    const files = (await fs.promises.readdir(__dirname)).filter(entry => entry.endsWith('.test.js') &&
        (reopenTest ? entry === 'reopen.test.js' : workspaceTest ? entry === 'workspace.test.js' :
            entry !== 'workspace.test.js' && entry !== 'reopen.test.js'));
    if (!files.length) { throw new Error('No compiled test files found'); }
    for (const entry of files) { mocha.addFile(path.join(__dirname, entry)); }
    await mocha.loadFilesAsync();
    await new Promise<void>((resolve, reject) => {
        mocha.run(failures => failures ? reject(new Error(`${failures} test(s) failed`)) : resolve());
    });
}
