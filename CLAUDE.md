# Obsidian Plugin Development Guidelines

## UI Text Rules

- **Sentence case**: Only capitalize the first word and proper nouns (Amazon, Kindle, Obsidian)
  - Good: `'Import from my clippings file'`
  - Bad: `'Import From My Clippings File'`

- **Settings headings**: Don't include "settings" or the plugin name in headings

- **Descriptions**: Must end with `.?!)`

## Code Style

- **No direct DOM manipulation**: Avoid `innerHTML`/`outerHTML`, use Obsidian's API instead

- **No inline styles**: Use CSS classes instead of `element.style.x`
  - Use `setCssProps()` for dynamic CSS properties

- **Proper async handling**:
  - Await promises or use `void` operator for fire-and-forget
  - Don't return promises from void callbacks

- **No `console.log`**: Only `console.warn`, `console.error`, `console.debug` allowed

- **Use `Setting` API for headings**: `new Setting(containerEl).setName(...).setHeading()` instead of raw HTML

## Release Checklist

- `manifest.json` - must match PR description exactly
- `main.js` - compiled output
- `styles.css` - if needed
- Version in release name must match `manifest.json` (no `v` prefix)

## Linting

Install the official ESLint plugin:
```bash
npm install --save-dev eslint-plugin-obsidian
```
