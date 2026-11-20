# Scratches for Visual Studio Code

[Русский](README.md) · **English**

Scratches is a VS Code extension for temporary notes, code snippets, and experiments. Keep files in a directory of your choice, organize them by project or share them across projects, search their contents, and compare text in the familiar VS Code diff editor.

**VS Code 1.105 or later** is required. Your files remain in the directory you choose on disk.

## Features

- Project and shared files in a dedicated panel, with selection of saved projects.
- File creation with frequently used extensions and search by content.
- Comparison of two files or a file and editable clipboard text.
- Batch file and folder operations, plus cleanup of old scratch files.
- Experimental macOS file clipboard support and drag-and-drop import.

## Getting started

1. Install the extension and open **Scratches** in the Activity Bar.
2. Select an existing storage directory using **Set Root Path** in the welcome view, **Scratches: Set Root Path...** in the command palette, or the `scratches.path` setting.
3. Choose **New Scratch File**, select an extension (or add one using **New extension**, such as `.py`), and edit the suggested filename if needed.

The `scratches.path` setting accepts `~` or `~/` at the beginning of a path (also `~\` on Windows). A `~` elsewhere in a path is left unchanged.

The default filename contains a UTC timestamp in `YYYYMMDD-HHMMSS` format and the chosen extension. Include the leading `.` when adding an extension. The list and usage counts are stored in the extension's global state for the VS Code profile. Frequently used extensions appear first; ties retain insertion order. Usage is recorded after file creation when the final name ends in the chosen extension.

On first access, an existing `<root>/.vscode/.recentFileExtension.json` is imported with zero counts and left in place. If it is unreadable or invalid, fix or restore it and retry. Lists from other roots are not merged automatically. This state is not synchronized with Settings Sync.

## Views and projects

- **Project Files** shows a project directory under `<root>/.projects`. Use its selection button or **Scratches: Select Project** to choose an open workspace folder or a saved project, even when its original folder is closed. Saved projects show a name and part of a hash; their original paths are not stored in the directory. The first workspace folder is used by default, and the selection is stored in workspace state. If the selection becomes unavailable, the first open folder is used. Projects with the same folder name have separate directories. Legacy `<root>/<project name>` directories remain accessible through **All Files**; move any needed files manually.
- **Shared Files** shows the shared `<root>/share` directory.
- **All Files** shows the storage root, including project and shared directories.

Without an open workspace folder, you can select a saved project and create files in it. Until a project is selected, use **Shared Files** or **All Files**.

## Search contents

**Search File Contents** in each view searches recursively for literal text, ignoring case. Select a result to open its first matching line. Search reads saved UTF-8 content and skips binary files, symbolic links, unsaved documents, and files over 1 MiB. It stops after 100 matching files or 10,000 tree entries, reports skipped items and limits, and can be cancelled.

## Working with files

The trees support creating files and folders, opening, renaming, copying paths, copying and moving, deleting, and refreshing. Select up to 100 items for Copy, Cut, or Delete. A new scratch file is created in the selected view's root; a new folder can be created inside a selected item.

Drag files and folders within or between Scratches trees to move them to a folder, or to the parent folder when dropping on a file. Drop on an empty tree area to target its root. Conflicts are skipped without overwriting; unsaved files and folders containing unsaved documents are not moved. In local desktop VS Code on macOS, files and folders can also be dropped from Finder into Scratches: they are copied and the originals remain in place. Import depends on VS Code supplying local file URIs; actual Finder compatibility still needs manual verification.

Trees refresh automatically after external changes, including in nested folders. VS Code may exclude paths through `files.watcherExclude` or temporarily suspend watching a remote directory. Use **Refresh** and, if necessary, select the root again.

## Compare files and text

To compare text files, choose **Select for Compare** on the first file and **Compare with Selected (select first file)** on the second. The latter is disabled until a first file is selected. Alternatively, select exactly two files in one view and choose **Compare Selected (select two files)**. VS Code opens its standard diff editor; **Scratches: Swap Compared Files** in the command palette opens the last file pair in reverse order.

Comparison supports regular UTF-8 files up to 10 MiB, including files from different views. Binary files and symbolic links are rejected. VS Code displays unsaved changes in open editors; type and size checks use the saved file. The extension does not create snapshots or version history.

To compare a scratch file with clipboard text, choose **Compare with Clipboard** on the file or open it and run **Scratches: Compare Active File with Clipboard**. The file, including unsaved changes, is on the left; an editable temporary document is on the right. An empty clipboard produces an empty document for manual input. Clipboard text is limited to 10 MiB and is not stored in the extension's history. VS Code manages the temporary document, which you can save if needed. **Swap Compared Files** applies to file-to-file comparisons.

## Copying, moving, and deleting

Batch paste skips conflicts without overwriting, processes remaining items, and reports the result. Failed items remain available for retry. If both a folder and its descendant are selected, only the folder is processed. Copying folders rejects nested symbolic links; a partially created destination may remain after an error. Copying or moving a folder into itself is prohibited.

In local desktop VS Code on macOS, Copy and Paste experimentally use the system file clipboard. Paste imports up to 100 regular files or folders; Copy publishes references to selected items. The internal local-file list format used by VS Code Explorer is also supported but may change in future versions. Symbolic links are not imported, and existing files are not overwritten. Check destinations after partial errors. Other operating systems and remote environments use the internal Scratches clipboard.

Cut between Scratches views moves items. Files pasted from outside are copied. On macOS, Cut also places file references in the system clipboard as a copy; pasting into another application does not promise to move the source.

Save changes in an open file and in all open files inside a folder before renaming or deleting it. Save files before moving with Cut; Clear skips unsaved files and reports them. Rename uses VS Code to update open tabs. Rename and delete recheck the selected item's identity after input or confirmation; select it again if it was replaced.

Use the **Delete** context menu or `⌘ + Backspace` on macOS (`Ctrl + Delete` on Windows and Linux). After confirmation, the item moves to the system trash.

Cut and Clear move open saved documents through VS Code and update their tabs. If a file is opened during a move, the source is retained and a destination copy may remain; check both directories before retrying.

Symbolic links are hidden in the trees; the root and service directories must be ordinary directories. A closed file moved across filesystems is copied without overwriting, then the source is removed. If the source changes, becomes dirty, or cannot be removed, the copy remains. After a move failure, check both directories: the destination may exist or be incomplete.

Copy and Cut record the selected file's identity and reject a replaced source. Save open source documents before copying. If the source or its paths change during copying, or unsaved changes appear, the extension warns that the destination may be incomplete or stale and retains the selection for retry. If a source view changes during Copy or Cut, the extension reports it; for Cut, the source is retained if deletion has not yet started. Check both directories and select the file again before retrying.

## Cleaning up old files

After confirmation, **Clear** moves files directly inside the selected view's root to its `trash` directory. It selects files beginning with `YYYYMMDD-HHMMSS` when the date is valid and both that date and the modification time are no later than **the start of the entered date in UTC**. Nested folders are not scanned. For example, a file modified after `2026-10-21 00:00 UTC` is excluded when the entered date is `2026-10-21`.

Between date entry and confirmation, candidates have a red warning icon in the corresponding tree. This is a preliminary list: files with unsaved changes, conflicts, or errors may be skipped. Marks disappear after the response or root change. If a file cannot be inspected while preparing the list, cleanup is cancelled. Changed files are skipped. A root change cancels pending input or confirmation and stops remaining moves; a move already in progress may finish. Delete uses the system trash after confirmation.

## Development

```sh
npm ci
npm run compile
npm run lint
npm test
```

Development requires Node.js 22.13 or later in the 22 series, or Node.js 24 or later. `npm test` runs compilation and lint, followed by tests in VS Code Extension Development Host using `@vscode/test-electron`: without a project, with a test workspace, and after reopening with another first folder. The default is VS Code 1.105.0, downloaded on first use. Set `SCRATCHES_VSCODE_VERSION` to select another version or `SCRATCHES_VSCODE_EXECUTABLE` to use an installed editor. See `scripts/run-tests.cjs` and `src/test/runner.ts`.

Tests use an isolated temporary VS Code profile, removed after the host exits. To test cross-filesystem moves, set `SCRATCHES_TEST_CROSS_DEVICE_DIR` to a writable directory on another volume; those tests are skipped without it. CI is configured for Linux, macOS, and Windows; some Windows symlink tests are skipped if creation is not permitted.

See the [Russian extension map](EXTENSION_MAP.ru.md) and [English map for agents](EXTENSION_MAP.md). Agent instructions are in [AGENTS.md](AGENTS.md), with the Russian source in [AGENTS.ru.md](AGENTS.ru.md).

License: [MIT](LICENSE).
