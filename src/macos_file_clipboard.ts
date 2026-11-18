import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

interface ClipboardResult {
    paths?: string[];
    changeCount: number;
}

// Данные передаются через stdin, чтобы пути не попадали в аргументы процесса.
export async function macOSFileClipboard(action: 'read' | 'write' | 'write-explorer-test', paths: string[] = [], boardName?: string): Promise<ClipboardResult> {
    if (process.platform !== 'darwin') { throw new Error('macOS file clipboard is unavailable on this platform'); }
    const helper = path.resolve(__dirname, '..', 'res', 'macos-file-clipboard.js');
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', helper, action, ...(boardName ? [boardName] : [])],
            { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => { child.kill(); }, 10000);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) { child.kill(); } });
        child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16384) { child.kill(); } });
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0) { reject(new Error(`File clipboard operation failed: ${stderr.slice(0, 1024)}`)); return; }
            try {
                const result: unknown = JSON.parse(stdout);
                if (!result || typeof result !== 'object' || !('changeCount' in result) ||
                    typeof result.changeCount !== 'number' || (action === 'read' &&
                    (!('paths' in result) || !Array.isArray(result.paths) || !result.paths.every(item => typeof item === 'string')))) {
                    throw new Error('Invalid file clipboard response');
                }
                const parsed = result as ClipboardResult & { resources?: unknown };
                if (action === 'read' && parsed.resources !== undefined) {
                    if (typeof parsed.resources !== 'string') { throw new Error('Invalid Explorer clipboard data'); }
                    const lines = parsed.resources.split('\n');
                    if (!lines.length || lines.length > 100 || lines.some(line => !line)) {
                        throw new Error('Invalid Explorer file list');
                    }
                    parsed.paths = lines.map(line => {
                        if (!line.startsWith('file:///')) { throw new Error('Only local file URLs are supported from Explorer'); }
                        const uri = new URL(line);
                        if (uri.protocol !== 'file:' || uri.hostname || uri.search || uri.hash) {
                            throw new Error('Only local file URLs are supported from Explorer');
                        }
                        const file = fileURLToPath(uri);
                        if (!path.isAbsolute(file) || file.includes('\0')) { throw new Error('Invalid Explorer file path'); }
                        return file;
                    });
                }
                resolve(parsed);
            } catch (error) { reject(error); }
        });
        child.stdin.on('error', () => { /* Завершение процесса сообщает об ошибке отдельно. */ });
        child.stdin.end(action === 'write' ? JSON.stringify(paths) : action === 'write-explorer-test' ? paths.join('\n') : '');
    });
}
