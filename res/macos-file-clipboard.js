ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
    const command = argv[0];
    const board = argv[1] ? $.NSPasteboard.pasteboardWithName(argv[1]) : $.NSPasteboard.generalPasteboard;
    if (!board || !board.js) { throw new Error('Pasteboard is unavailable'); }
    if (command === 'read') {
        const objects = board.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
        const paths = [];
        if (objects && objects.js) {
            for (let index = 0; index < Number(objects.count); index++) {
                paths.push(ObjC.unwrap(objects.objectAtIndex(index).path));
            }
        }
        let resources;
        if (!paths.length) {
            const data = board.dataForType('code/file-list');
            if (data && data.js) {
                if (Number(data.length) > 1024 * 1024) { throw new Error('Explorer clipboard data is too large'); }
                const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
                if (!text || !text.js) { throw new Error('Invalid Explorer clipboard encoding'); }
                resources = ObjC.unwrap(text);
            }
        }
        return JSON.stringify({ paths, resources, changeCount: Number(board.changeCount) });
    }
    if (command === 'write-explorer-test' && argv[1]) {
        const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
        board.clearContents;
        if (!board.setDataForType(data, 'code/file-list')) { throw new Error('Could not write test data'); }
        return JSON.stringify({ changeCount: Number(board.changeCount) });
    }
    if (command === 'write') {
        const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
        const input = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
        const paths = JSON.parse(input);
        if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !path.startsWith('/'))) {
            throw new Error('Expected absolute file paths');
        }
        const urls = paths.map(path => $.NSURL.fileURLWithPath(path));
        board.clearContents;
        if (!board.writeObjects($(urls))) { throw new Error('Could not write file URLs'); }
        return JSON.stringify({ changeCount: Number(board.changeCount) });
    }
    throw new Error('Unsupported pasteboard operation');
}
