import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { searchTextFiles } from '../content_search';

suite('Content search', () => {
    let root: string;
    setup(() => { root = fs.mkdtempSync(path.join(process.env.SCRATCHES_TEST_TMPDIR || os.tmpdir(), 'scratches-search-')); });
    teardown(() => { if (!process.env.SCRATCHES_TEST_TMPDIR) { fs.rmSync(root, { recursive: true, force: true }); } });

    test('finds literal case-insensitive text recursively and skips non-text and dirty files', async function () {
        fs.mkdirSync(path.join(root, 'nested'));
        fs.writeFileSync(path.join(root, 'nested', 'match.txt'), 'first\nHello Мир\nlast');
        fs.writeFileSync(path.join(root, 'binary'), Buffer.from([0, 72, 101, 108, 108, 111]));
        fs.writeFileSync(path.join(root, 'invalid'), Buffer.from([0xff, 0xfe, 0x48]));
        fs.writeFileSync(path.join(root, 'dirty.txt'), 'hello');
        const large = fs.openSync(path.join(root, 'large.txt'), 'w');
        fs.ftruncateSync(large, 1024 * 1024 + 1);
        fs.closeSync(large);
        if (process.platform !== 'win32') { fs.symlinkSync(path.join(root, 'nested'), path.join(root, 'link')); }
        const result = await searchTextFiles(root, 'hello мир', () => undefined, () => undefined,
            file => file.endsWith('dirty.txt'), () => false);
        assert.deepStrictEqual(result.matches.map(item => ({ relative: path.relative(root, item.filePath), line: item.line, preview: item.preview })),
            [{ relative: path.join('nested', 'match.txt'), line: 1, preview: 'Hello Мир' }]);
        assert.ok(result.skipped >= 4);
        assert.strictEqual(result.cancelled, false);
        assert.strictEqual(result.truncated, false);
    });

    test('limits results and supports cancellation', async () => {
        for (let index = 0; index < 101; index++) { fs.writeFileSync(path.join(root, `${index}.txt`), 'match'); }
        const result = await searchTextFiles(root, 'match', () => undefined, () => undefined, () => false, () => false);
        assert.strictEqual(result.matches.length, 100);
        assert.strictEqual(result.truncated, true);
        const cancelled = await searchTextFiles(root, 'match', () => undefined, () => undefined, () => false, () => true);
        assert.strictEqual(cancelled.cancelled, true);
        assert.deepStrictEqual(cancelled.matches, []);
    });

    test('stops when root validation fails', async () => {
        await assert.rejects(searchTextFiles(root, 'match', () => { throw new Error('root changed'); },
            () => undefined, () => false, () => false), /root changed/);
    });
});
