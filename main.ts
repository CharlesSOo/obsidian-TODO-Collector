import { Plugin, TFile, TFolder, TAbstractFile, PluginSettingTab, Setting, App } from 'obsidian';
import { around } from 'monkey-around';

interface TodoItem {
  text: string;
  sourceBasename: string;
}

interface TodoCollectorSettings {
  outputFilePath: string;
  excludeFolders: string[];
  pinToTop: boolean;
}

const DEFAULT_SETTINGS: TodoCollectorSettings = {
  outputFilePath: 'TODO.md',
  excludeFolders: [],
  pinToTop: true
};

export default class TodoCollectorPlugin extends Plugin {
  settings: TodoCollectorSettings = DEFAULT_SETTINGS;
  private isUpdatingOutputFile: boolean = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private iconObserver: MutationObserver | null = null;

  async onload() {
    await this.loadSettings();

    // Wait for layout ready, then do initial collection and patch file explorer
    this.app.workspace.onLayoutReady(async () => {
      await this.collectAndWriteTodos();
      this.patchFileExplorer();
    });

    // Register file events
    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        this.handleFileChange(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('create', (file: TAbstractFile) => {
        this.handleFileChange(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', () => {
        this.debouncedCollect();
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', () => {
        this.debouncedCollect();
      })
    );

    // Manual refresh command
    this.addCommand({
      id: 'refresh-todos',
      name: 'Refresh TODO collection',
      callback: () => this.collectAndWriteTodos()
    });

    // Settings tab
    this.addSettingTab(new TodoCollectorSettingTab(this.app, this));
  }

  onunload() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.iconObserver) {
      this.iconObserver.disconnect();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private patchFileExplorer() {
    const plugin = this;

    // Get file explorer leaf
    const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (!fileExplorerLeaf) {
      console.log('TODO Collector: File explorer not found');
      return;
    }

    const fileExplorer = fileExplorerLeaf.view as any;

    // Patch getSortedFolderItems on the file explorer view prototype
    this.register(
      around(fileExplorer.constructor.prototype, {
        getSortedFolderItems(original: any) {
          return function (this: any, folder: TFolder, ...args: any[]) {
            // Call original sort first
            const result = original.call(this, folder, ...args);

            // Only pin if enabled and we're at the root folder
            if (plugin.settings.pinToTop && folder && folder.isRoot()) {
              const todoIndex = result.findIndex(
                (item: any) => item.file?.path === plugin.settings.outputFilePath
              );
              if (todoIndex > 0) {
                const [todoItem] = result.splice(todoIndex, 1);
                result.unshift(todoItem);
              }
            }

            return result;
          };
        },
      })
    );

    // Trigger a re-sort to apply the pin
    this.refreshFileExplorer();
  }

  private refreshFileExplorer() {
    const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (fileExplorerLeaf) {
      const fileExplorer = fileExplorerLeaf.view as any;
      if (fileExplorer.requestSort) {
        fileExplorer.requestSort();
      }
    }
    // Add pin icon after sort
    setTimeout(() => this.addPinIcon(), 100);

    // Set up observer to keep icon when file explorer re-renders
    this.setupIconObserver();
  }

  private setupIconObserver() {
    if (this.iconObserver) return; // Already set up

    const fileExplorer = document.querySelector('.nav-files-container');
    if (!fileExplorer) return;

    this.iconObserver = new MutationObserver(() => {
      this.addPinIcon();
    });

    this.iconObserver.observe(fileExplorer, {
      childList: true,
      subtree: true
    });
  }

  private addPinIcon() {
    if (!this.settings.pinToTop) return;

    // Find the TODO file element
    const fileExplorer = document.querySelector('.nav-files-container');
    if (!fileExplorer) return;

    const todoTitle = fileExplorer.querySelector(
      `.nav-file-title[data-path="${this.settings.outputFilePath}"]`
    );
    if (!todoTitle) return;

    // Check if icon already exists
    if (todoTitle.querySelector('.todo-pin-icon')) return;

    // Create pin icon
    const pinIcon = document.createElement('span');
    pinIcon.className = 'todo-pin-icon';
    pinIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
    pinIcon.style.cssText = 'margin-right: 2px; margin-left: -18px; opacity: 0.6; display: inline-flex; align-items: center;';

    // Insert at the beginning of the title
    todoTitle.insertBefore(pinIcon, todoTitle.firstChild);
  }

  private handleFileChange(file: TAbstractFile) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (this.isUpdatingOutputFile) return;
    if (file.path === this.settings.outputFilePath) return;

    this.debouncedCollect();
  }

  private debouncedCollect() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.collectAndWriteTodos();
    }, 1000);
  }

  async collectAndWriteTodos() {
    this.isUpdatingOutputFile = true;

    try {
      const todos = await this.collectTodos();
      const content = this.formatOutput(todos);

      const outputFile = this.app.vault.getAbstractFileByPath(this.settings.outputFilePath);

      if (outputFile instanceof TFile) {
        await this.app.vault.modify(outputFile, content);
      } else {
        await this.app.vault.create(this.settings.outputFilePath, content);
      }
    } catch (error) {
      console.error('TODO Collector: Error updating output file', error);
    } finally {
      setTimeout(() => {
        this.isUpdatingOutputFile = false;
      }, 100);
    }
  }

  private async collectTodos(): Promise<TodoItem[]> {
    const todos: TodoItem[] = [];
    const files = this.app.vault.getMarkdownFiles();
    const uncheckedPattern = /^(\s*)- \[ \] (.+)$/gm;

    for (const file of files) {
      if (file.path === this.settings.outputFilePath) continue;
      if (this.isExcluded(file)) continue;

      const content = await this.app.vault.read(file);
      let match;

      while ((match = uncheckedPattern.exec(content)) !== null) {
        todos.push({
          text: match[2].trim(),
          sourceBasename: file.basename
        });
      }

      uncheckedPattern.lastIndex = 0;
    }

    return todos;
  }

  private isExcluded(file: TFile): boolean {
    for (const folder of this.settings.excludeFolders) {
      if (folder && (file.path.startsWith(folder + '/') || file.path === folder)) {
        return true;
      }
    }
    return false;
  }

  private formatOutput(todos: TodoItem[]): string {
    let output = '# Collected TODOs\n\n';

    for (const todo of todos) {
      output += `- [ ] ${todo.text} [[${todo.sourceBasename}]]\n`;
    }

    if (todos.length === 0) {
      output += '*No unchecked TODOs found.*\n';
    }

    return output;
  }
}

class TodoCollectorSettingTab extends PluginSettingTab {
  plugin: TodoCollectorPlugin;

  constructor(app: App, plugin: TodoCollectorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'TODO Collector Settings' });

    new Setting(containerEl)
      .setName('Output file path')
      .setDesc('Path to the file where TODOs will be collected (relative to vault root)')
      .addText(text => text
        .setPlaceholder('TODOs.md')
        .setValue(this.plugin.settings.outputFilePath)
        .onChange(async (value) => {
          this.plugin.settings.outputFilePath = value || 'TODOs.md';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('Comma-separated list of folders to skip (e.g., templates,archive)')
      .addText(text => text
        .setPlaceholder('templates,archive')
        .setValue(this.plugin.settings.excludeFolders.join(','))
        .onChange(async (value) => {
          this.plugin.settings.excludeFolders = value
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
          await this.plugin.saveSettings();
          await this.plugin.collectAndWriteTodos();
        }));

    new Setting(containerEl)
      .setName('Pin to top of sidebar')
      .setDesc('Keep the TODO file pinned to the top of the file explorer')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.pinToTop)
        .onChange(async (value) => {
          this.plugin.settings.pinToTop = value;
          await this.plugin.saveSettings();
        }));
  }
}
