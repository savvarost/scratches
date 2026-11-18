import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';

export interface ContentSearchResult {
    matches: Array<{ filePath: string; line: number; preview: string; snapshot: fs.Stats }>;
    skipped: number;
    truncated: boolean;
    cancelled: boolean;
}

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_MATCHES = 100;

/** Поиск читает только ограниченное количество данных и не следует символическим ссылкам. */
export async function searchTextFiles(
    root: string,
    query: string,
    validateRoot: () => void,
    validatePath: (filePath: string) => void,
    isDirty: (filePath: string) => boolean,
    isCancelled: () => boolean,
): Promise<ContentSearchResult> {
    const result: ContentSearchResult = { matches: [], skipped: 0, truncated: false, cancelled: false };
    const pending = [root];
    const needle = query.toLowerCase();
    let entries = 0;
    validateRoot();
    while (pending.length && !result.truncated) {
        if (isCancelled()) { result.cancelled = true; break; }
        validateRoot();
        const directory = pending.pop()!;
        let handle: fs.Dir;
        try { validatePath(directory); handle = await fs.promises.opendir(directory); }
        catch { validateRoot(); result.skipped++; continue; }
        try {
            for await (const entry of handle) {
                if (isCancelled()) { result.cancelled = true; break; }
                validateRoot();
                if (++entries > MAX_ENTRIES) { result.truncated = true; break; }
                const filePath = path.join(directory, entry.name);
                if (entry.isSymbolicLink()) { result.skipped++; continue; }
                if (entry.isDirectory()) { pending.push(filePath); continue; }
                if (!entry.isFile()) { result.skipped++; continue; }
                let file: fs.promises.FileHandle | undefined;
                try {
                    validatePath(filePath);
                    if (isDirty(filePath)) { result.skipped++; continue; }
                    const before = await fs.promises.lstat(filePath);
                    if (!before.isFile() || before.size > MAX_BYTES) { result.skipped++; continue; }
                    file = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
                    const opened = await file.stat();
                    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_BYTES) {
                        result.skipped++; continue;
                    }
                    const buffer = Buffer.allocUnsafe(Math.min(MAX_BYTES + 1, opened.size + 1));
                    let offset = 0;
                    while (offset < buffer.length) {
                        if (isCancelled()) { result.cancelled = true; break; }
                        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
                        if (!bytesRead) { break; }
                        offset += bytesRead;
                    }
                    if (result.cancelled) { break; }
                    const bytes = buffer.subarray(0, offset);
                    if (offset > MAX_BYTES || bytes.some(byte => byte < 32 && ![9, 10, 12, 13].includes(byte))) {
                        result.skipped++; continue;
                    }
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    validateRoot();
                    validatePath(filePath);
                    const after = await file.stat();
                    const current = await fs.promises.lstat(filePath);
                    validateRoot();
                    if (isDirty(filePath) || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino ||
                        current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs ||
                        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
                        result.skipped++; continue;
                    }
                    const lines = text.split(/\r\n|\n|\r/);
                    const index = lines.findIndex(line => line.toLowerCase().includes(needle));
                    if (index >= 0) {
                        result.matches.push({ filePath, line: index, preview: lines[index].trim().slice(0, 200), snapshot: after });
                        if (result.matches.length >= MAX_MATCHES) { result.truncated = true; break; }
                    }
                } catch { validateRoot(); result.skipped++; }
                finally { await file?.close(); }
            }
        } catch { validateRoot(); result.skipped++; }
        if (result.cancelled) { break; }
    }
    return result;
}
