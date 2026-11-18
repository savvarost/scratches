# Scratches extension map

The Russian source is [EXTENSION_MAP.ru.md](EXTENSION_MAP.ru.md). Agents use this English version. Update the Russian source first and synchronize this translation in the same task.

## Execution flow

```text
package.json: settings, views, commands, and menus
    ↓ extension activation
src/extension.ts: activate → Scratches.createView
    ↓ scratches.path setting
src/scratches.ts: DirectoryViewer for Project / Shared / All
    ├─ src/directory.ts: paths and directory creation
    ├─ src/file_extension.ts: extension selection and persistence
    ├─ src/content_search.ts: bounded search of saved UTF-8 text
    ├─ src/compare_files.ts: text file validation before comparison
    ├─ src/root_watcher.ts: shared filesystem watcher and event coalescing
    ├─ src/macos_file_clipboard.ts and res/macos-file-clipboard.js: experimental macOS file clipboard bridge
    └─ filesystem and VS Code TreeDataProvider / commands
```

`src/extension.ts` also registers an empty data provider for the welcome view, `scratches.setRootPath`, and responds to configuration changes. `Scratches.createView` creates a shared extensions manager and a separate `DirectoryViewer` for each available view. `FileItem` connects a URI and item type to tree commands.

## Where to make changes

| Task | Locations and connections |
| --- | --- |
| Add a command or change a menu or shortcut | Declaration and placement in `package.json`; registration and handler in `DirectoryViewer.initDirectoryViewer` and `DirectoryViewer` in `src/scratches.ts`. Identifiers are tied to `viewId`; keyboard deletion uses the selected item and requires confirmation. |
| Add a view | Container, `views`, commands, and menus in `package.json`; creation through `Scratches.createView` with a root path in `src/scratches.ts`. Account for registration lifecycle. |
| Change tree display | `getChildren`, `getTreeItem`, `refresh`, and `FileItem` in `src/scratches.ts`, and the shared watcher in `src/root_watcher.ts`; manifest context-menu conditions use `contextValue`. |
| Change content search | `searchContent` in `src/scratches.ts`, `src/content_search.ts`, commands and buttons in `package.json`; check limits, cancellation, root changes and opening results. |
| Change file comparison | `selectForCompare`, `compareWithSelected`, `compareSelected`, `compareWithClipboard` and `Scratches.swapComparison` in `src/scratches.ts`, text validation in `src/compare_files.ts`, menus and commands in `package.json`. |
| Change storage or project association | Path functions in `src/directory.ts`, configuration and change handling in `src/extension.ts`, view creation in `src/scratches.ts`. The first workspace folder determines the project directory. |
| Change file creation or extension list | `newScratchFile` in `src/scratches.ts`, `FileExtensionsManager` in `src/file_extension.ts`: `globalState` persistence, legacy JSON import, and sorting by usage count. |
| Change cleanup or file operations | Corresponding `DirectoryViewer` methods in `src/scratches.ts`; check confirmations, path boundaries, name conflicts, and tree refreshes. |
| Change build or testing | Scripts and dependencies in `package.json`, `tsconfig.json`, `eslint.config.mjs`, `scripts/run-tests.cjs`, `src/test/runner.ts`, tests in `src/test/`, the OS matrix in `.github/workflows/ci.yml`, and package exclusions in `.vscodeignore`. |

## Current state and possible improvements

These are observations from the code, not promised features or a prioritized plan.

- Some file operations use synchronous `fs`; errors and conflicts are not handled consistently. File creation uses exclusive mode; an open document is moved via VS Code WorkspaceEdit, while other files use a hard link or copying across filesystems followed by source removal. Root identity is checked before operations, including opening and copying a path, and again after reading a tree or copying; the selected source identity is checked before pasting, renaming and deletion, and its state after copying and before source removal during a move. Unsaved changes are checked before and after copying, and before deletion. Path checks and file operations are not atomic, so concurrent replacement remains a risk.
- Views are not initialized without a configured path; after initial setup, views remain registered and their roots are updated when the configuration or workspace folders change. One recursive root watcher coalesces frequent external events and refreshes all views; it and its pending update are disposed on root changes and shutdown. Events may be excluded by `files.watcherExclude`. Copy and Cut check for changes to the source and destination view roots. An invalid path does not block the root-selection command. Integration tests cover root changes and recovery from errors.
- The first workspace folder has a separate directory based on a hash of its URI; it is created before setting the view root, including when the folder changes. Without an open folder the project view has no root and project file creation is unavailable. Legacy directories named after projects remain accessible in All Files; there is no automatic migration. Other folders in a multi-root workspace are not considered.
- Trees support selection of up to 100 items; Copy/Cut process files and folders, and Delete asks for one confirmation. Descendants of selected folders are not processed separately. Conflicts are skipped and partial results reported. Folder copying rejects nested symbolic links, while moving uses VS Code to update tabs; partial copies are not removed automatically.
- The experimental macOS file clipboard bridge is connected to Copy/Cut/Paste in local desktop VS Code. External paste copies up to 100 regular files or folders without overwriting; internal Cut remains a move. Explorer's internal `code/file-list` format is read for local file URIs; this private contract may change. The bridge and format have been tested with a separate named pasteboard; copying from the actual Explorer still needs verification.
- Cleanup compares a valid date in the name and `mtime`, only processes the root, does not overwrite files in `trash`, skips files with unsaved changes or changed after the candidate list was prepared, and reports partial success. Candidates are marked in the corresponding tree until confirmation ends; changing the root also clears the marks. An inspection error cancels candidate selection; the root is rechecked afterwards. The file snapshot is checked when its move starts. Operations waiting for input or confirmation are cancelled when the root changes; cleanup stops processing remaining files, although a move already in progress may complete.
- Content search recursively scans the selected view root and only saved UTF-8 text; binary and unsaved files, symbolic links and files over 1 MiB are skipped. Limits are 10,000 entries and 100 matching files; results point to the first matching line. Cancellation and root/file checks before opening are supported.
- Comparing two files uses `vscode.diff`; the first selection is shared across views and comparison with it is disabled until selection, while comparing a selection is enabled within one view for two distinct files. The selection is cleared when the root changes or a missing or replaced file is detected; a palette command swaps sides. Validation supports regular UTF-8 files up to 10 MiB; the diff uses open editor contents including unsaved changes. No version history is created.
- Tests in `src/test/extension.test.ts` cover selected file operations; `src/test/workspace.test.ts` checks root changes and a workspace event in a separate window with a project, and `src/test/reopen.test.ts` checks reopening with a different first folder. Changes should test user behavior, input cancellation, errors, and file operations in temporary directories; VS Code integration is tested through the Extension Development Host.

- Clipboard comparison opens a validated scratch file and an editable untitled document using `vscode.diff`; the palette command uses the active file, while tree commands use the selected file. Text is limited to 10 MiB, and the root and file identity are rechecked after awaits. The extension does not keep clipboard history.
