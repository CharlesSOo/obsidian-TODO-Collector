# TODO Collector

A simple plugin that gathers all your unchecked tasks from across your vault into one file.

## What it does

Every time you save a note, this plugin scans your vault for unchecked markdown tasks (`- [ ]`) and collects them into a single TODO file. Each task includes a backlink to the original note so you can jump straight to the source.

The output looks like this:

```markdown
# Collected TODOs

- [ ] Fix the login bug [[Project Notes]]
- [ ] Buy groceries [[Daily/2024-01-15]]
- [ ] Review PR #42 [[Work]]
```

## Features

- Automatic collection on file save
- Backlinks to source notes
- Pin your TODO file to the top of the file explorer (works with any sort order)
- Pin icon indicator
- Exclude specific folders from scanning

## Settings

- **Output file path** - Where to save the collected TODOs (default: `TODO.md`)
- **Excluded folders** - Comma-separated list of folders to ignore
- **Pin to top** - Keep the TODO file at the top of the sidebar

## Installation

### From Obsidian

1. Open Settings
2. Go to Community Plugins and disable Safe Mode
3. Click Browse and search for "TODO Collector"
4. Install and enable the plugin

### Manual

1. Download `main.js` and `manifest.json` from the latest release
2. Create a folder called `todo-collector` in your vault's `.obsidian/plugins/` directory
3. Move the downloaded files into that folder
4. Reload Obsidian and enable the plugin in Settings

## Commands

- **Refresh TODO collection** - Manually trigger a collection (useful if auto-update missed something)

## Notes

The pin feature uses monkey-patching to intercept Obsidian's file sorting. This means your TODO file stays at the top regardless of how you sort the file explorer. All other files maintain their normal sort order.

## License

MIT
