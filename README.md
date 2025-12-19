# TODO Collector

A simple plugin that gathers all your unchecked tasks from across your vault into one file.

![Screenshot](assets/screenshot.png)

## What it does

Every time you save a note, this plugin scans your vault for unchecked markdown tasks (`- [ ]`) and collects them into a single TODO file. Each task includes a backlink to the original note so you can jump straight to the source.

## Features

- Automatic collection on file save
- Backlinks to source notes
- Pin TODO file to top of file explorer (works with any sort order)
- Time-based groups with drag-and-drop
- Two-way sync - checking off a task in the TODO file also checks it in the source note
- Completed section for checked tasks
- Exclude specific folders from scanning

## Time-Based Groups

Enable this in settings to organize your TODOs into sections:

```markdown
## Today

- [ ] Urgent task [[Daily Notes]]

## Tomorrow

- [ ] Less urgent [[Project]]

## Next 7 Days

- [ ] This week sometime [[Ideas]]

## Backlog

- [ ] Eventually [[Someday]]
```

**Drag and drop** (Reading mode):
- Drag tasks between sections to re-categorize
- Drag tasks onto other tasks to reorder
- Drop into empty space below a section header
- Grip dots appear on hover

**Keyboard commands** (any mode):
- Move task to Today
- Move task to Tomorrow
- Move task to Next 7 Days
- Move task to Backlog

To assign hotkeys: **Settings > Hotkeys**, search "TODO Collector"

## Settings

- **Output file path** - Where to save the collected TODOs (default: `TODO.md`)
- **Excluded folders** - Comma-separated list of folders to ignore
- **Pin to top** - Keep the TODO file at the top of the sidebar
- **Time-based groups** - Enable Today/Tomorrow/Next 7 Days/Backlog sections
- **Show checked section** - Move completed tasks to a section at the bottom

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

- **Refresh TODO collection** - Manually trigger a collection
- **Move task to Today** - Move current task to Today section
- **Move task to Tomorrow** - Move current task to Tomorrow section
- **Move task to Next 7 Days** - Move current task to Next 7 Days section
- **Move task to Backlog** - Move current task to Backlog section

## Credits

- [monkey-around](https://github.com/pjeby/monkey-around) - Used for file explorer pinning
- [Draggable Tasklists](https://github.com/fr33lo/draggable-tasklists-plugin) - Drag-and-drop implementation reference

## License

MIT
