import * as fs from 'fs';
import { TextDecoder } from 'util';

export const MAX_COMPARE_BYTES = 10 * 1024 * 1024;

/** Ограниченно проверяем текст, не читая файл по символической ссылке. */
export async function validateTextFile(filePath: string, expected: Pick<fs.Stats, 'dev' | 'ino'>): Promise<void> {
    const before = await fs.promises.lstat(filePath);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
        throw new Error('Selected file was replaced or is not a regular file');
    }
    if (before.size > MAX_COMPARE_BYTES) { throw new Error('File exceeds the 10 MiB comparison limit'); }
    const file = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size > MAX_COMPARE_BYTES) {
            throw new Error('Selected file was replaced or is too large');
        }
        const buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, MAX_COMPARE_BYTES + 1));
        let size = 0;
        while (size < buffer.length) {
            const read = await file.read(buffer, size, buffer.length - size, size);
            if (!read.bytesRead) { break; }
            size += read.bytesRead;
        }
        const bytes = buffer.subarray(0, size);
        if (size > MAX_COMPARE_BYTES || bytes.some(byte => byte < 32 && ![9, 10, 12, 13].includes(byte))) {
            throw new Error('Only UTF-8 text files can be compared');
        }
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('Only UTF-8 text files can be compared'); }
        const after = await file.stat();
        const current = await fs.promises.lstat(filePath);
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino ||
            after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
            current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
            throw new Error('File changed while checking; try again');
        }
    } finally { await file.close(); }
}
