# Repository instructions

The source of these instructions is the Russian [AGENTS.ru.md](AGENTS.ru.md). Agents use this English [AGENTS.md](AGENTS.md). When changing rules, update the Russian file first, then fully synchronize the English translation in the same task; do not introduce conflicting rules.

## Project

Scratches is a TypeScript VS Code extension for working with temporary files. See [README.md](README.md) for behavior and setup, and the English [EXTENSION_MAP.md](EXTENSION_MAP.md), used by agents, for components and change points. The Russian [EXTENSION_MAP.ru.md](EXTENSION_MAP.ru.md) is the source of the map: update it first, then synchronize the English translation in the same task. `package.json` defines public settings, commands, views, and menus; implementation lives in `src/`.

## Making changes

- Before editing, inspect the affected flow, manifest, callers, and tests; preserve existing user changes.
- Preserve compatibility of command identifiers, the `scratches.path` setting, storage format, and view behavior. If a contract change is necessary, describe it explicitly and provide for migration.
- When changing commands or views, keep code registration aligned with declarations, menus, and conditions in `package.json`. Account for reconfiguration and disposal of VS Code resources.
- File operations work with user data: check path boundaries, conflicts, errors, and partial success; prevent unexpected overwrites or deletion. Test them in temporary directories.
- Write code and identifiers in English; comments explain intent and constraints. Follow the existing TypeScript and ESLint configuration, and do not upgrade dependencies without a need.
- Add meaningful behavioral tests for changes, proportionate to risk. Do not treat the sample test as existing functional coverage.

## Verification

After installing dependencies with `npm ci`, use `npm run compile` and `npm run lint`; for behavioral changes run `npm test` (the Extension Development Host may need to download VS Code). Report what was not verified and why. For documentation-only changes, check facts against the source, links, and the final diff. Update the map and README as needed when architecture or user-facing behavior changes.
