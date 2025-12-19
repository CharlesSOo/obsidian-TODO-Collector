import { Plugin, TFile, TFolder, TAbstractFile, PluginSettingTab, Setting, App, MarkdownPostProcessorContext, MarkdownView, Editor } from 'obsidian';
import { around } from 'monkey-around';

interface TodoItem {
  text: string;
  sourceBasename: string;
}

type TimeGroup = 'today' | 'tomorrow' | 'week' | 'backlog';

const TIME_GROUP_HEADERS: Record<TimeGroup, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'Next 7 Days',
  backlog: 'Backlog'
};

const HEADER_TO_GROUP: Record<string, TimeGroup> = {
  'today': 'today',
  'tomorrow': 'tomorrow',
  'next 7 days': 'week',
  'backlog': 'backlog'
};

interface TodoCollectorSettings {
  outputFilePath: string;
  excludeFolders: string[];
  pinToTop: boolean;
  showCheckedSection: boolean;
  checkedSectionHeader: string;
  enableTimeGroups: boolean;
}

const DEFAULT_SETTINGS: TodoCollectorSettings = {
  outputFilePath: 'TODO.md',
  excludeFolders: [],
  pinToTop: true,
  showCheckedSection: true,
  checkedSectionHeader: 'Completed',
  enableTimeGroups: false
};

export default class TodoCollectorPlugin extends Plugin {
  settings: TodoCollectorSettings = DEFAULT_SETTINGS;
  private isUpdatingOutputFile: boolean = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private iconObserver: MutationObserver | null = null;
  private previousCheckedItems: string[] = [];
  private itemGroups: Map<string, TimeGroup> = new Map();
  // Store ordered list of items per group for custom sorting
  private itemOrder: Record<TimeGroup, string[]> = {
    today: [],
    tomorrow: [],
    week: [],
    backlog: []
  };

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

    // Commands to move tasks between groups (work in any mode)
    this.addCommand({
      id: 'move-to-today',
      name: 'Move task to Today',
      editorCallback: (editor, view) => this.moveTaskToGroup(editor, view, 'today')
    });

    this.addCommand({
      id: 'move-to-tomorrow',
      name: 'Move task to Tomorrow',
      editorCallback: (editor, view) => this.moveTaskToGroup(editor, view, 'tomorrow')
    });

    this.addCommand({
      id: 'move-to-week',
      name: 'Move task to Next 7 Days',
      editorCallback: (editor, view) => this.moveTaskToGroup(editor, view, 'week')
    });

    this.addCommand({
      id: 'move-to-backlog',
      name: 'Move task to Backlog',
      editorCallback: (editor, view) => this.moveTaskToGroup(editor, view, 'backlog')
    });

    // Register drag-drop post-processor for reading mode
    this.registerMarkdownPostProcessor((el, ctx) => {
      this.addDragDropHandlers(el, ctx);
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
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Load itemGroups from stored data
    if (data?.itemGroups) {
      this.itemGroups = new Map(Object.entries(data.itemGroups));
    }
    // Load itemOrder from stored data
    if (data?.itemOrder) {
      this.itemOrder = {
        today: data.itemOrder.today || [],
        tomorrow: data.itemOrder.tomorrow || [],
        week: data.itemOrder.week || [],
        backlog: data.itemOrder.backlog || []
      };
    }
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      itemGroups: Object.fromEntries(this.itemGroups),
      itemOrder: this.itemOrder
    });
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

  private addDragDropHandlers(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    // Only add drag-drop if time groups are enabled and this is our TODO file
    if (!this.settings.enableTimeGroups) return;
    if (ctx.sourcePath !== this.settings.outputFilePath) return;

    // Find all task list items and track their section
    const taskItems = el.querySelectorAll('li.task-list-item');
    let currentSection: TimeGroup = 'backlog';

    // Helper to find section for an element
    const findSectionForElement = (element: HTMLElement): TimeGroup => {
      let el: HTMLElement | null = element;
      while (el) {
        const prevSibling = el.previousElementSibling;
        if (prevSibling?.tagName === 'H2') {
          const headerText = prevSibling.textContent?.toLowerCase() || '';
          return HEADER_TO_GROUP[headerText] || 'backlog';
        }
        el = el.parentElement;
      }
      return 'backlog';
    };

    taskItems.forEach((item: Element) => {
      const li = item as HTMLElement;

      // Extract the proper item key from the rendered HTML
      const link = li.querySelector('a.internal-link');
      const sourceBasename = link?.getAttribute('data-href') || link?.textContent || '';

      let taskText = '';
      li.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          taskText += node.textContent;
        }
      });
      taskText = taskText.trim();

      const itemKey = `${taskText} [[${sourceBasename}]]`.toLowerCase().trim();
      li.setAttribute('data-todo-key', itemKey);

      // Make draggable
      li.setAttribute('draggable', 'true');
      li.style.cursor = 'grab';
      li.style.position = 'relative';

      // Add drag handle (grip dots)
      const dragHandle = document.createElement('span');
      dragHandle.className = 'todo-drag-handle';
      dragHandle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`;
      dragHandle.style.cssText = 'position: absolute; left: -20px; top: 50%; transform: translateY(-50%); opacity: 0; transition: opacity 0.15s; cursor: grab; color: var(--text-muted);';
      li.insertBefore(dragHandle, li.firstChild);

      li.addEventListener('mouseenter', () => {
        li.style.backgroundColor = 'var(--background-modifier-hover)';
        dragHandle.style.opacity = '1';
      });
      li.addEventListener('mouseleave', () => {
        li.style.backgroundColor = '';
        li.style.borderTop = '';
        li.style.borderBottom = '';
        dragHandle.style.opacity = '0';
      });

      li.addEventListener('dragstart', (e: DragEvent) => {
        if (!e.dataTransfer) return;
        li.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', itemKey);
      });

      li.addEventListener('dragend', () => {
        li.style.opacity = '';
      });

      // Make items drop targets for reordering
      li.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }

        // Show insertion indicator
        const rect = li.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        if (e.clientY < midY) {
          li.style.borderTop = '3px solid var(--interactive-accent)';
          li.style.borderBottom = '';
          li.style.marginTop = '-3px';
        } else {
          li.style.borderBottom = '3px solid var(--interactive-accent)';
          li.style.borderTop = '';
          li.style.marginTop = '';
        }
      });

      li.addEventListener('dragleave', (e: DragEvent) => {
        li.style.borderTop = '';
        li.style.borderBottom = '';
        li.style.marginTop = '';
      });

      li.addEventListener('drop', async (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        li.style.borderTop = '';
        li.style.borderBottom = '';
        li.style.marginTop = '';

        if (!e.dataTransfer) return;

        const draggedKey = e.dataTransfer.getData('text/plain');
        const targetKey = li.getAttribute('data-todo-key');

        console.log('TODO Collector: Drop on item - dragged:', draggedKey, 'target:', targetKey);

        if (!draggedKey || !targetKey || draggedKey === targetKey) return;

        // Determine insert position (before or after)
        const rect = li.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;

        console.log('TODO Collector: Insert before:', insertBefore);

        // Move the item
        await this.reorderItem(draggedKey, targetKey, insertBefore);
      });
    });

    // Find section headers and make them + their sections drop targets
    const headers = el.querySelectorAll('h2');
    headers.forEach((header: Element) => {
      const h2 = header as HTMLElement;
      const headerText = h2.textContent?.toLowerCase() || '';

      if (!HEADER_TO_GROUP[headerText]) return;

      const targetGroup = HEADER_TO_GROUP[headerText];

      h2.style.transition = 'background-color 0.2s';

      // Make header a drop target
      h2.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        h2.style.backgroundColor = 'var(--interactive-accent)';
        h2.style.color = 'var(--text-on-accent)';
      });

      h2.addEventListener('dragleave', () => {
        h2.style.backgroundColor = '';
        h2.style.color = '';
      });

      h2.addEventListener('drop', async (e: DragEvent) => {
        e.preventDefault();
        h2.style.backgroundColor = '';
        h2.style.color = '';

        if (!e.dataTransfer) return;

        const itemKey = e.dataTransfer.getData('text/plain');
        if (!itemKey) return;

        await this.moveItemToGroup(itemKey, targetGroup);
      });

      // Find the list (ul) after the header and make it a drop zone too
      let nextEl = h2.nextElementSibling;
      while (nextEl && nextEl.tagName !== 'UL' && nextEl.tagName !== 'H2') {
        nextEl = nextEl.nextElementSibling;
      }

      if (nextEl && nextEl.tagName === 'UL') {
        const ul = nextEl as HTMLElement;
        ul.style.minHeight = '40px'; // Ensure there's always a drop zone
        ul.style.paddingBottom = '20px';

        ul.addEventListener('dragover', (e: DragEvent) => {
          // Only handle if not over a child li
          if ((e.target as HTMLElement).tagName === 'UL') {
            e.preventDefault();
            if (e.dataTransfer) {
              e.dataTransfer.dropEffect = 'move';
            }
            ul.style.backgroundColor = 'var(--background-modifier-hover)';
          }
        });

        ul.addEventListener('dragleave', (e: DragEvent) => {
          if ((e.target as HTMLElement).tagName === 'UL') {
            ul.style.backgroundColor = '';
          }
        });

        ul.addEventListener('drop', async (e: DragEvent) => {
          // Only handle if dropped directly on ul (not on a li)
          if ((e.target as HTMLElement).tagName !== 'UL') return;

          e.preventDefault();
          ul.style.backgroundColor = '';

          if (!e.dataTransfer) return;

          const itemKey = e.dataTransfer.getData('text/plain');
          if (!itemKey) return;

          // Move to this group at the end
          await this.moveItemToGroup(itemKey, targetGroup);
        });
      }

      // Also create a drop zone after empty sections (when there's no ul)
      if (!nextEl || nextEl.tagName === 'H2') {
        const dropZone = document.createElement('div');
        dropZone.className = 'todo-drop-zone';
        dropZone.style.cssText = 'min-height: 40px; margin: 8px 0; border-radius: 4px; transition: background-color 0.2s;';

        h2.after(dropZone);

        dropZone.addEventListener('dragover', (e: DragEvent) => {
          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
          }
          dropZone.style.backgroundColor = 'var(--background-modifier-hover)';
          dropZone.style.border = '2px dashed var(--interactive-accent)';
        });

        dropZone.addEventListener('dragleave', () => {
          dropZone.style.backgroundColor = '';
          dropZone.style.border = '';
        });

        dropZone.addEventListener('drop', async (e: DragEvent) => {
          e.preventDefault();
          dropZone.style.backgroundColor = '';
          dropZone.style.border = '';

          if (!e.dataTransfer) return;

          const itemKey = e.dataTransfer.getData('text/plain');
          if (!itemKey) return;

          await this.moveItemToGroup(itemKey, targetGroup);
        });
      }
    });
  }

  private async moveItemToGroup(itemKey: string, targetGroup: TimeGroup) {
    // Remove from old group's order
    const oldGroup = this.itemGroups.get(itemKey) || 'backlog';
    this.itemOrder[oldGroup] = this.itemOrder[oldGroup].filter(k => k !== itemKey);

    // Add to new group's order (at end)
    this.itemGroups.set(itemKey, targetGroup);
    if (!this.itemOrder[targetGroup].includes(itemKey)) {
      this.itemOrder[targetGroup].push(itemKey);
    }

    await this.saveSettings();
    await this.collectAndWriteTodos();
  }

  private async reorderItem(draggedKey: string, targetKey: string, insertBefore: boolean) {
    // Get target's group
    const targetGroup = this.itemGroups.get(targetKey) || 'backlog';
    const draggedGroup = this.itemGroups.get(draggedKey) || 'backlog';

    // Remove dragged item from its old position
    this.itemOrder[draggedGroup] = this.itemOrder[draggedGroup].filter(k => k !== draggedKey);

    // Update group assignment
    this.itemGroups.set(draggedKey, targetGroup);

    // Find target position in the new group
    let targetIndex = this.itemOrder[targetGroup].indexOf(targetKey);
    if (targetIndex === -1) {
      // Target not in order yet, add both
      this.itemOrder[targetGroup].push(draggedKey);
    } else {
      // Insert before or after target
      if (!insertBefore) {
        targetIndex++;
      }
      this.itemOrder[targetGroup].splice(targetIndex, 0, draggedKey);
    }

    await this.saveSettings();
    await this.collectAndWriteTodos();
  }

  private moveTaskToGroup(editor: Editor, view: MarkdownView, targetGroup: TimeGroup): void {
    // Only work in TODO file with time groups enabled
    if (!this.settings.enableTimeGroups) {
      console.log('TODO Collector: Time groups not enabled');
      return;
    }

    const filePath = view.file?.path;
    if (filePath !== this.settings.outputFilePath) {
      console.log('TODO Collector: Not in TODO file');
      return;
    }

    // Get current line
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);

    // Check if it's a task line
    const taskMatch = line.match(/^-\s*\[[ x]\]\s*(.+)$/i);
    if (!taskMatch) {
      console.log('TODO Collector: Not a task line');
      return;
    }

    // Extract the item key from the line
    const itemContent = taskMatch[1].trim();
    const itemKey = itemContent.toLowerCase();

    console.log('TODO Collector: Moving', itemKey, 'to', targetGroup);

    // Use the moveItemToGroup method for consistency
    this.moveItemToGroup(itemKey, targetGroup);
  }

  private handleFileChange(file: TAbstractFile) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (this.isUpdatingOutputFile) return;

    // If the TODO file was modified by user (checking off items), handle it
    if (file.path === this.settings.outputFilePath) {
      this.debouncedProcessChecked();
      return;
    }

    this.debouncedCollect();
  }

  private debouncedProcessChecked() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.processCheckedItems();
    }, 500);
  }

  private async processCheckedItems() {
    const outputFile = this.app.vault.getAbstractFileByPath(this.settings.outputFilePath);
    if (!(outputFile instanceof TFile)) return;

    this.isUpdatingOutputFile = true;

    try {
      const content = await this.app.vault.read(outputFile);

      // Parse existing content
      const lines = content.split('\n');
      const checkedItems: string[] = [];
      const prevChecked = new Set(this.previousCheckedItems || []);
      let currentSection: TimeGroup | null = null;
      let groupsChanged = false;
      let inFrontmatter = false;
      let frontmatterDone = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Handle frontmatter (skip it)
        if (trimmed === '---') {
          if (!frontmatterDone) {
            inFrontmatter = !inFrontmatter;
            if (!inFrontmatter) frontmatterDone = true;
            continue;
          }
          // After frontmatter, --- is the Completed section separator
          currentSection = null;
          continue;
        }

        if (inFrontmatter) continue;

        // Check for section headers (## Today, ## Tomorrow, etc.)
        if (this.settings.enableTimeGroups && trimmed.startsWith('## ')) {
          const headerText = trimmed.slice(3).toLowerCase();
          currentSection = HEADER_TO_GROUP[headerText] || null;
          continue;
        }

        // Match checked items: - [x] item or variations
        const checkedMatch = trimmed.match(/^-?\s*-?\s*\[x\]\s*(.+)$/i);
        if (checkedMatch) {
          checkedItems.push(checkedMatch[1].trim());
          continue;
        }

        // Match unchecked items and track their section
        if (this.settings.enableTimeGroups && currentSection) {
          const uncheckedMatch = trimmed.match(/^-?\s*\[ \]\s*(.+)$/);
          if (uncheckedMatch) {
            const itemKey = uncheckedMatch[1].trim().toLowerCase();
            const existingGroup = this.itemGroups.get(itemKey);
            if (existingGroup !== currentSection) {
              this.itemGroups.set(itemKey, currentSection);
              groupsChanged = true;
            }
          }
        }
      }

      // Find newly checked (in current but not in previous)
      for (const item of checkedItems) {
        if (!prevChecked.has(item)) {
          await this.updateSourceTask(item, true);
        }
      }

      // Find newly unchecked (in previous but not in current)
      const currentChecked = new Set(checkedItems);
      for (const item of this.previousCheckedItems) {
        if (!currentChecked.has(item)) {
          await this.updateSourceTask(item, false);
        }
      }

      // Store current checked items for next comparison
      this.previousCheckedItems = checkedItems;

      // Save group changes if any
      if (groupsChanged) {
        await this.saveSettings();
      }

      // Collect fresh unchecked TODOs from vault
      const freshTodos = await this.collectTodos();

      // Merge: keep checked items, add fresh unchecked
      const output = this.formatOutputWithChecked(freshTodos, checkedItems);

      await this.app.vault.modify(outputFile, output);
    } catch (error) {
      console.error('TODO Collector: Error processing checked items', error);
    } finally {
      setTimeout(() => {
        this.isUpdatingOutputFile = false;
      }, 100);
    }
  }

  private async updateSourceTask(item: string, checked: boolean) {
    // Parse item to get task text and source note
    // Format: "task text [[SourceNote]]"
    const match = item.match(/^(.+)\s+\[\[([^\]]+)\]\]$/);
    if (!match) return;

    const taskText = match[1].trim();
    const sourceName = match[2];

    // Find the source file
    const sourceFile = this.app.metadataCache.getFirstLinkpathDest(sourceName, '');
    if (!(sourceFile instanceof TFile)) return;

    try {
      const content = await this.app.vault.read(sourceFile);

      let newContent: string;
      if (checked) {
        // Check it off
        newContent = content.replace(`- [ ] ${taskText}`, `- [x] ${taskText}`);
      } else {
        // Uncheck it
        newContent = content.replace(`- [x] ${taskText}`, `- [ ] ${taskText}`);
      }

      if (newContent !== content) {
        await this.app.vault.modify(sourceFile, newContent);
      }
    } catch (error) {
      console.error(`TODO Collector: Error updating source ${sourceName}`, error);
    }
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
    return this.formatOutputWithChecked(todos, []);
  }

  private getItemKey(text: string, source: string): string {
    return `${text} [[${source}]]`.toLowerCase().trim();
  }

  private formatOutputWithChecked(todos: TodoItem[], checkedItems: string[]): string {
    // Filter out todos that are already in checked list
    const checkedSet = new Set(checkedItems.map(item => item.toLowerCase().trim()));
    const activeTodos = todos.filter(todo => {
      const todoKey = this.getItemKey(todo.text, todo.sourceBasename);
      return !checkedSet.has(todoKey);
    });

    // If time groups disabled, use flat output
    if (!this.settings.enableTimeGroups) {
      let output = '';
      for (const todo of activeTodos) {
        output += `- [ ] ${todo.text} [[${todo.sourceBasename}]]\n`;
      }

      // Add checked section if enabled and has items
      if (this.settings.showCheckedSection && checkedItems.length > 0) {
        output += '\n\n\n\n\n\n\n\n---\n';
        output += `${this.settings.checkedSectionHeader}\n\n`;
        for (const item of checkedItems) {
          output += `- [x] ${item}\n`;
        }
      }

      return output;
    }

    // Time groups enabled - group items by category
    const groups: Record<TimeGroup, { key: string; line: string }[]> = {
      today: [],
      tomorrow: [],
      week: [],
      backlog: []
    };

    for (const todo of activeTodos) {
      const itemKey = this.getItemKey(todo.text, todo.sourceBasename);
      const group = this.itemGroups.get(itemKey) || 'backlog';
      groups[group].push({
        key: itemKey,
        line: `- [ ] ${todo.text} [[${todo.sourceBasename}]]`
      });
    }

    // Sort each group by stored order
    const groupOrder: TimeGroup[] = ['today', 'tomorrow', 'week', 'backlog'];
    for (const group of groupOrder) {
      const order = this.itemOrder[group];
      if (order.length > 0) {
        groups[group].sort((a, b) => {
          const indexA = order.indexOf(a.key);
          const indexB = order.indexOf(b.key);
          // Items not in order go to the end
          const posA = indexA === -1 ? Infinity : indexA;
          const posB = indexB === -1 ? Infinity : indexB;
          return posA - posB;
        });
      }
    }

    let output = '';

    for (const group of groupOrder) {
      output += `## ${TIME_GROUP_HEADERS[group]}\n\n`;
      if (groups[group].length > 0) {
        output += groups[group].map(item => item.line).join('\n') + '\n';
      }
      output += '\n';
    }

    // Add checked section if enabled and has items
    if (this.settings.showCheckedSection && checkedItems.length > 0) {
      output += '\n\n---\n';
      output += `${this.settings.checkedSectionHeader}\n\n`;
      for (const item of checkedItems) {
        output += `- [x] ${item}\n`;
      }
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

    new Setting(containerEl)
      .setName('Time-based groups')
      .setDesc('Organize TODOs into sections: Today, Tomorrow, Next 7 Days, Backlog. Drag items between sections in Reading mode.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTimeGroups)
        .onChange(async (value) => {
          this.plugin.settings.enableTimeGroups = value;
          await this.plugin.saveSettings();
          await this.plugin.collectAndWriteTodos();
        }));

    new Setting(containerEl)
      .setName('Show checked section')
      .setDesc('When you check off a TODO, move it to a collapsible section')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showCheckedSection)
        .onChange(async (value) => {
          this.plugin.settings.showCheckedSection = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Checked section header')
      .setDesc('Text to show above completed items')
      .addText(text => text
        .setPlaceholder('Completed')
        .setValue(this.plugin.settings.checkedSectionHeader)
        .onChange(async (value) => {
          this.plugin.settings.checkedSectionHeader = value || 'Completed';
          await this.plugin.saveSettings();
        }));
  }
}
