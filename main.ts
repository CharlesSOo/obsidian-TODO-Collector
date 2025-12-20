import { App, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile, MarkdownPostProcessorContext, Editor, MarkdownView, Platform, setIcon } from 'obsidian';
import { around } from 'monkey-around';
import { ViewPlugin, ViewUpdate, DecorationSet, Decoration, EditorView, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

type TimeGroup = 'today' | 'tomorrow' | 'week' | 'backlog';

interface TodoItem {
  text: string;
  sourceBasename: string;
}

interface GroupedItem {
  key: string;
  line: string;
}

interface TodoCollectorSettings {
  outputFilePath: string;
  excludeFolders: string[];
  pinToTop: boolean;
  showCheckedSection: boolean;
  checkedSectionHeader: string;
  enableTimeGroups: boolean;
  decayDays: number;
  showDecayCountdown: boolean;
}

// Type for saved plugin data
interface SavedPluginData extends TodoCollectorSettings {
  itemGroups?: Record<string, TimeGroup>;
  itemOrder?: Record<TimeGroup, string[]>;
  completedTimestamps?: Record<string, number>;
}

// Type for file explorer view
interface FileExplorerView {
  requestSort?: () => void;
  constructor: {
    prototype: {
      getSortedFolderItems: (folder: TAbstractFile, ...args: unknown[]) => { file?: TAbstractFile }[];
    };
  };
}

// Type for folder items
interface FolderItem {
  file?: TAbstractFile;
}

const TIME_GROUP_HEADERS: Record<TimeGroup, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'Next 7 days',
  backlog: 'Backlog'
};

const HEADER_TO_GROUP: Record<string, TimeGroup> = {
  'today': 'today',
  'tomorrow': 'tomorrow',
  'next 7 days': 'week',
  'backlog': 'backlog'
};

const DEFAULT_SETTINGS: TodoCollectorSettings = {
  outputFilePath: 'TODO.md',
  excludeFolders: [],
  pinToTop: true,
  showCheckedSection: true,
  checkedSectionHeader: 'Completed',
  enableTimeGroups: false,
  decayDays: 0,
  showDecayCountdown: true
};

// Store dragged line globally for CM6 drag/drop
let draggedLineNum: number | null = null;

// CodeMirror 6 drag handle widget for Live Preview
class DragHandleWidget extends WidgetType {
  private plugin: TodoCollectorPlugin;
  private lineNum: number;

  constructor(plugin: TodoCollectorPlugin, lineNum: number) {
    super();
    this.plugin = plugin;
    this.lineNum = lineNum;
  }

  toDOM(view: EditorView): HTMLElement {
    const isMobile = Platform.isMobile;

    const handle = document.createElement('span');
    handle.className = 'todo-drag-handle-cm6';
    if (isMobile) {
      handle.addClass('is-mobile');
    }
    handle.draggable = true;
    setIcon(handle, 'grip-vertical');

    handle.addEventListener('mouseenter', () => {
      handle.addClass('todo-drag-handle-hover');
    });

    handle.addEventListener('mouseleave', () => {
      handle.removeClass('todo-drag-handle-hover');
      handle.addClass('todo-drag-handle-muted');
    });

    handle.addEventListener('dragstart', (e) => {
      draggedLineNum = this.lineNum;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'todo-drag');
      }
      handle.addClass('todo-drag-handle-grabbing');
      handle.addClass('todo-drag-handle-hover');
    });

    handle.addEventListener('dragend', () => {
      handle.removeClass('todo-drag-handle-grabbing');
      handle.removeClass('todo-drag-handle-hover');
      draggedLineNum = null;
    });

    return handle;
  }

  eq(other: DragHandleWidget): boolean {
    return this.lineNum === other.lineNum;
  }

  ignoreEvent(): boolean {
    return false; // Allow all events through
  }
}

// Create the Live Preview extension
function createLivePreviewExtension(plugin: TodoCollectorPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      plugin: TodoCollectorPlugin;

      constructor(view: EditorView) {
        this.plugin = plugin;
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        if (!this.plugin.settings.enableTimeGroups) {
          return Decoration.none;
        }

        const builder = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;

        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          const text = line.text;

          // Match task lines: - [ ] or - [x]
          if (/^\s*-\s*\[[ x]\]/i.test(text)) {
            const deco = Decoration.widget({
              widget: new DragHandleWidget(this.plugin, i),
              side: -1 // Before the line content
            });
            builder.add(line.from, line.from, deco);
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        dragover(e: DragEvent) {
          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
          }
        },
        drop(e: DragEvent, view: EditorView) {
          e.preventDefault();

          const fromLine = draggedLineNum;
          if (!fromLine || fromLine < 1) return;

          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return;

          const doc = view.state.doc;
          if (fromLine > doc.lines) return;

          const toLine = doc.lineAt(pos).number;
          if (fromLine === toLine) return;

          const fromText = doc.line(fromLine).text;
          const toText = doc.line(toLine).text;

          // Check if dropping on a section header
          const isHeader = /^##\s/.test(toText);

          // Build new document
          const lines: string[] = [];
          for (let i = 1; i <= doc.lines; i++) {
            if (i === fromLine) continue; // Skip source line

            const lineText = doc.line(i).text;

            if (isHeader && i === toLine) {
              // Dropping on header - add line right after header
              lines.push(lineText);
              lines.push(fromText);
            } else if (!isHeader && i === toLine) {
              // Dropping on task - insert before or after based on direction
              if (fromLine > toLine) {
                lines.push(fromText);
                lines.push(lineText);
              } else {
                lines.push(lineText);
                lines.push(fromText);
              }
            } else {
              lines.push(lineText);
            }
          }

          view.dispatch({
            changes: { from: 0, to: doc.length, insert: lines.join('\n') }
          });

          // Trigger immediate update instead of waiting for debounce
          setTimeout(() => { void plugin.processCheckedItems(); }, 50);
        }
      }
    }
  );
}

export default class TodoCollectorPlugin extends Plugin {
  settings: TodoCollectorSettings = DEFAULT_SETTINGS;
  private isUpdatingOutputFile = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private iconObserver: MutationObserver | null = null;
  private previousCheckedItems: string[] = [];
  private itemGroups: Map<string, TimeGroup> = new Map();
  private itemOrder: Record<TimeGroup, string[]> = {
    today: [],
    tomorrow: [],
    week: [],
    backlog: []
  };
  private completedTimestamps: Record<string, number> = {};

  async onload() {
    await this.loadSettings();

    this.app.workspace.onLayoutReady(() => {
      void this.collectAndWriteTodos();
      this.patchFileExplorer();
    });

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        this.handleFileChange(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
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

    this.addCommand({
      id: 'refresh-todos',
      name: 'Refresh todo collection',
      callback: () => { void this.collectAndWriteTodos(); }
    });

    this.addCommand({
      id: 'move-to-today',
      name: 'Move task to today',
      editorCallback: (editor: Editor, view: MarkdownView) => { void this.moveTaskToGroup(editor, view, 'today'); }
    });

    this.addCommand({
      id: 'move-to-tomorrow',
      name: 'Move task to tomorrow',
      editorCallback: (editor: Editor, view: MarkdownView) => { void this.moveTaskToGroup(editor, view, 'tomorrow'); }
    });

    this.addCommand({
      id: 'move-to-week',
      name: 'Move task to next 7 days',
      editorCallback: (editor: Editor, view: MarkdownView) => { void this.moveTaskToGroup(editor, view, 'week'); }
    });

    this.addCommand({
      id: 'move-to-backlog',
      name: 'Move task to backlog',
      editorCallback: (editor: Editor, view: MarkdownView) => { void this.moveTaskToGroup(editor, view, 'backlog'); }
    });

    this.addCommand({
      id: 'open-todo-file',
      name: 'Open todo file',
      callback: () => { void this.openTodoFile(); }
    });

    this.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      this.addDragDropHandlers(el, ctx);
    });

    // Register CodeMirror 6 extension for Live Preview drag
    this.registerEditorExtension(createLivePreviewExtension(this));

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
    const data = await this.loadData() as SavedPluginData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    if (data?.itemGroups) {
      for (const [key, value] of Object.entries(data.itemGroups)) {
        this.itemGroups.set(key, value);
      }
    }
    if (data?.itemOrder) {
      this.itemOrder = {
        today: data.itemOrder.today || [],
        tomorrow: data.itemOrder.tomorrow || [],
        week: data.itemOrder.week || [],
        backlog: data.itemOrder.backlog || []
      };
    }
    if (data?.completedTimestamps) {
      this.completedTimestamps = data.completedTimestamps;
    }
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      itemGroups: Object.fromEntries(this.itemGroups),
      itemOrder: this.itemOrder,
      completedTimestamps: this.completedTimestamps
    });
  }

  async openTodoFile() {
    await this.app.workspace.openLinkText(this.settings.outputFilePath, '', false);
  }

  patchFileExplorer() {
    const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];

    if (!fileExplorerLeaf) {
      console.warn('TODO Collector: File explorer not found');
      return;
    }

    const fileExplorer = fileExplorerLeaf.view as FileExplorerView;
    const settings = this.settings;

    this.register(
      around(fileExplorer.constructor.prototype, {
        getSortedFolderItems(original: (folder: TAbstractFile, ...args: unknown[]) => FolderItem[]) {
          return function(this: FileExplorerView, folder: TAbstractFile & { isRoot?: () => boolean }, ...args: unknown[]) {
            const result = original.call(this, folder, ...args);

            if (settings.pinToTop && folder && folder.isRoot?.()) {
              const todoIndex = result.findIndex(
                (item: FolderItem) => item.file?.path === settings.outputFilePath
              );

              if (todoIndex > 0) {
                const [todoItem] = result.splice(todoIndex, 1);
                result.unshift(todoItem);
              }
            }

            return result;
          };
        }
      })
    );

    this.refreshFileExplorer();
  }

  refreshFileExplorer() {
    const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (fileExplorerLeaf) {
      const fileExplorer = fileExplorerLeaf.view as FileExplorerView;
      if (fileExplorer.requestSort) {
        fileExplorer.requestSort();
      }
    }
    setTimeout(() => this.addPinIcon(), 100);
    this.setupIconObserver();
  }

  setupIconObserver() {
    if (this.iconObserver) return;

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

  addPinIcon() {
    if (!this.settings.pinToTop) return;

    const fileExplorer = document.querySelector('.nav-files-container');
    if (!fileExplorer) return;

    const todoTitle = fileExplorer.querySelector(
      `.nav-file-title[data-path="${this.settings.outputFilePath}"]`
    );
    if (!todoTitle) return;

    if (todoTitle.querySelector('.todo-pin-icon')) return;

    const pinIcon = document.createElement('span');
    pinIcon.className = 'todo-pin-icon';
    setIcon(pinIcon, 'pin');
    todoTitle.insertBefore(pinIcon, todoTitle.firstChild);
  }

  addDragDropHandlers(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    if (!this.settings.enableTimeGroups) return;
    if (ctx.sourcePath !== this.settings.outputFilePath) return;

    const taskItems = el.querySelectorAll('li.task-list-item');
    const isMobile = Platform.isMobile;

    taskItems.forEach((item) => {
      const li = item as HTMLLIElement;
      const link = li.querySelector('a.internal-link');
      const sourceBasename = link?.getAttribute('data-href') || link?.textContent || '';

      let taskText = '';
      li.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          taskText += node.textContent;
        }
      });
      taskText = taskText.trim();

      const itemKey = `${taskText} [[${sourceBasename}]]`.toLowerCase().trim();
      li.setAttribute('data-todo-key', itemKey);
      li.setAttribute('draggable', 'true');
      li.addClass('todo-task-item');
      if (isMobile) {
        li.addClass('is-mobile');
      }

      // Create drag handle
      const dragHandle = document.createElement('span');
      dragHandle.className = 'todo-drag-handle';
      if (isMobile) {
        dragHandle.addClass('is-mobile');
      }
      setIcon(dragHandle, 'grip-vertical');
      li.insertBefore(dragHandle, li.firstChild);

      // Touch events for mobile
      if (isMobile) {
        dragHandle.addEventListener('touchstart', (e: TouchEvent) => {
          e.preventDefault();
          dragHandle.addClass('todo-drag-handle-active');
        });

        dragHandle.addEventListener('touchend', () => {
          dragHandle.removeClass('todo-drag-handle-active');
          dragHandle.addClass('is-mobile');
        });
      }

      li.addEventListener('mouseenter', () => {
        dragHandle.addClass('todo-drag-handle-visible');
      });

      li.addEventListener('mouseleave', () => {
        dragHandle.removeClass('todo-drag-handle-visible');
        dragHandle.addClass('todo-drag-handle-hidden');
        li.removeClass('todo-drop-above');
        li.removeClass('todo-drop-below');
      });

      dragHandle.addEventListener('mouseenter', () => {
        dragHandle.addClass('todo-drag-handle-hover');
      });

      dragHandle.addEventListener('mouseleave', () => {
        dragHandle.removeClass('todo-drag-handle-hover');
        dragHandle.addClass('todo-drag-handle-muted');
      });

      dragHandle.addEventListener('mousedown', () => {
        dragHandle.addClass('todo-drag-handle-grabbing');
      });

      dragHandle.addEventListener('mouseup', () => {
        dragHandle.removeClass('todo-drag-handle-grabbing');
      });

      li.addEventListener('dragstart', (e: DragEvent) => {
        if (!e.dataTransfer) return;
        li.addClass('todo-item-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', itemKey);
      });

      li.addEventListener('dragend', () => {
        li.removeClass('todo-item-dragging');
      });

      li.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }

        const rect = li.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        li.removeClass('todo-drop-above');
        li.removeClass('todo-drop-below');
        if (e.clientY < midY) {
          li.addClass('todo-drop-above');
        } else {
          li.addClass('todo-drop-below');
        }
      });

      li.addEventListener('dragleave', () => {
        li.removeClass('todo-drop-above');
        li.removeClass('todo-drop-below');
      });

      li.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        li.removeClass('todo-drop-above');
        li.removeClass('todo-drop-below');

        if (!e.dataTransfer) return;

        const draggedKey = e.dataTransfer.getData('text/plain');
        const targetKey = li.getAttribute('data-todo-key');

        if (!draggedKey || !targetKey || draggedKey === targetKey) return;

        const rect = li.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;

        void this.reorderItem(draggedKey, targetKey, insertBefore);
      });
    });

    // Add drop handlers to section headers
    const headers = el.querySelectorAll<HTMLHeadingElement>('h2');
    headers.forEach((h2) => {
      // Strip count from header text (e.g., "Today (3)" -> "today")
      const headerText = (h2.textContent?.toLowerCase() || '').replace(/\s*\(\d+\)$/, '');

      if (!HEADER_TO_GROUP[headerText]) return;

      const targetGroup = HEADER_TO_GROUP[headerText];
      h2.addClass('todo-header-drop');

      h2.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        h2.addClass('todo-header-drop-active');
      });

      h2.addEventListener('dragleave', () => {
        h2.removeClass('todo-header-drop-active');
      });

      h2.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        h2.removeClass('todo-header-drop-active');

        if (!e.dataTransfer) return;

        const itemKey = e.dataTransfer.getData('text/plain');
        if (!itemKey) return;

        void this.moveItemToGroup(itemKey, targetGroup);
      });

      // Handle UL drop targets
      let nextEl = h2.nextElementSibling;
      while (nextEl && nextEl.tagName !== 'UL' && nextEl.tagName !== 'H2') {
        nextEl = nextEl.nextElementSibling;
      }

      if (nextEl && nextEl.tagName === 'UL') {
        const ul = nextEl as HTMLUListElement;
        ul.addClass('todo-ul-drop');

        ul.addEventListener('dragover', (e: DragEvent) => {
          if ((e.target as HTMLElement).tagName === 'UL') {
            e.preventDefault();
            if (e.dataTransfer) {
              e.dataTransfer.dropEffect = 'move';
            }
            ul.addClass('todo-ul-drop-active');
          }
        });

        ul.addEventListener('dragleave', (e: DragEvent) => {
          if ((e.target as HTMLElement).tagName === 'UL') {
            ul.removeClass('todo-ul-drop-active');
          }
        });

        ul.addEventListener('drop', (e: DragEvent) => {
          if ((e.target as HTMLElement).tagName !== 'UL') return;
          e.preventDefault();
          ul.removeClass('todo-ul-drop-active');

          if (!e.dataTransfer) return;

          const itemKey = e.dataTransfer.getData('text/plain');
          if (!itemKey) return;

          void this.moveItemToGroup(itemKey, targetGroup);
        });
      }

      // Create empty drop zone for sections without items
      if (!nextEl || nextEl.tagName === 'H2') {
        const dropZone = document.createElement('div');
        dropZone.className = 'todo-drop-zone';
        h2.after(dropZone);

        dropZone.addEventListener('dragover', (e: DragEvent) => {
          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
          }
          dropZone.addClass('todo-drop-zone-active');
        });

        dropZone.addEventListener('dragleave', () => {
          dropZone.removeClass('todo-drop-zone-active');
        });

        dropZone.addEventListener('drop', (e: DragEvent) => {
          e.preventDefault();
          dropZone.removeClass('todo-drop-zone-active');

          if (!e.dataTransfer) return;

          const itemKey = e.dataTransfer.getData('text/plain');
          if (!itemKey) return;

          void this.moveItemToGroup(itemKey, targetGroup);
        });
      }
    });
  }

  async moveItemToGroup(itemKey: string, targetGroup: TimeGroup) {
    const oldGroup = this.itemGroups.get(itemKey) || 'backlog';
    this.itemOrder[oldGroup] = this.itemOrder[oldGroup].filter(k => k !== itemKey);

    this.itemGroups.set(itemKey, targetGroup);

    if (!this.itemOrder[targetGroup].includes(itemKey)) {
      this.itemOrder[targetGroup].push(itemKey);
    }

    await this.saveSettings();
    await this.collectAndWriteTodos();
  }

  async reorderItem(draggedKey: string, targetKey: string, insertBefore: boolean) {
    const targetGroup = this.itemGroups.get(targetKey) || 'backlog';
    const draggedGroup = this.itemGroups.get(draggedKey) || 'backlog';

    this.itemOrder[draggedGroup] = this.itemOrder[draggedGroup].filter(k => k !== draggedKey);
    this.itemGroups.set(draggedKey, targetGroup);

    let targetIndex = this.itemOrder[targetGroup].indexOf(targetKey);
    if (targetIndex === -1) {
      this.itemOrder[targetGroup].push(draggedKey);
    } else {
      if (!insertBefore) {
        targetIndex++;
      }
      this.itemOrder[targetGroup].splice(targetIndex, 0, draggedKey);
    }

    await this.saveSettings();
    await this.collectAndWriteTodos();
  }

  async moveTaskToGroup(editor: Editor, view: MarkdownView, targetGroup: TimeGroup) {
    if (!this.settings.enableTimeGroups) {
      return;
    }

    const filePath = view.file?.path;
    if (filePath !== this.settings.outputFilePath) {
      return;
    }

    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);

    const taskMatch = line.match(/^-\s*\[[ x]\]\s*(.+)$/i);
    if (!taskMatch) {
      return;
    }

    const itemContent = taskMatch[1].trim();
    const itemKey = itemContent.toLowerCase();

    await this.moveItemToGroup(itemKey, targetGroup);
  }

  handleFileChange(file: TAbstractFile) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (this.isUpdatingOutputFile) return;

    if (file.path === this.settings.outputFilePath) {
      this.debouncedProcessChecked();
      return;
    }

    this.debouncedCollect();
  }

  debouncedProcessChecked() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.processCheckedItems();
    }, 500);
  }

  async processCheckedItems() {
    const outputFile = this.app.vault.getAbstractFileByPath(this.settings.outputFilePath);
    if (!(outputFile instanceof TFile)) return;

    this.isUpdatingOutputFile = true;

    try {
      const content = await this.app.vault.read(outputFile);
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

        if (trimmed === '---') {
          if (!frontmatterDone) {
            inFrontmatter = !inFrontmatter;
            if (!inFrontmatter) frontmatterDone = true;
            continue;
          }
          currentSection = null;
          continue;
        }

        if (inFrontmatter) continue;

        if (this.settings.enableTimeGroups && trimmed.startsWith('## ')) {
          // Strip count from header text (e.g., "## Today (3)" -> "today")
          const headerText = trimmed.slice(3).toLowerCase().replace(/\s*\(\d+\)$/, '');
          currentSection = HEADER_TO_GROUP[headerText] || null;
          continue;
        }

        const checkedMatch = trimmed.match(/^-?\s*-?\s*\[x\]\s*(.+)$/i);
        if (checkedMatch) {
          checkedItems.push(checkedMatch[1].trim());
          continue;
        }

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

      for (const item of checkedItems) {
        if (!prevChecked.has(item)) {
          await this.updateSourceTask(item, true);
          // Track when this item was completed
          const itemKey = item.toLowerCase().trim();
          if (!this.completedTimestamps[itemKey]) {
            this.completedTimestamps[itemKey] = Date.now();
          }
        }
      }

      const currentChecked = new Set(checkedItems);
      for (const item of this.previousCheckedItems) {
        if (!currentChecked.has(item)) {
          await this.updateSourceTask(item, false);
          // Remove timestamp when unchecked
          const itemKey = item.toLowerCase().trim();
          delete this.completedTimestamps[itemKey];
        }
      }

      this.previousCheckedItems = checkedItems;

      if (groupsChanged) {
        await this.saveSettings();
      }

      const freshTodos = await this.collectTodos();
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

  async updateSourceTask(item: string, checked: boolean) {
    const match = item.match(/^(.+)\s+\[\[([^\]]+)\]\]$/);
    if (!match) return;

    const taskText = match[1].trim();
    const sourceName = match[2];

    const sourceFile = this.app.metadataCache.getFirstLinkpathDest(sourceName, '');
    if (!(sourceFile instanceof TFile)) return;

    try {
      const content = await this.app.vault.read(sourceFile);
      let newContent: string;

      if (checked) {
        newContent = content.replace(`- [ ] ${taskText}`, `- [x] ${taskText}`);
      } else {
        newContent = content.replace(`- [x] ${taskText}`, `- [ ] ${taskText}`);
      }

      if (newContent !== content) {
        await this.app.vault.modify(sourceFile, newContent);
      }
    } catch (error) {
      console.error(`TODO Collector: Error updating source ${sourceName}`, error);
    }
  }

  debouncedCollect() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.collectAndWriteTodos();
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

  async collectTodos(): Promise<TodoItem[]> {
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

  isExcluded(file: TFile): boolean {
    for (const folder of this.settings.excludeFolders) {
      if (folder && (file.path.startsWith(folder + '/') || file.path === folder)) {
        return true;
      }
    }
    return false;
  }

  formatOutput(todos: TodoItem[]): string {
    return this.formatOutputWithChecked(todos, []);
  }

  getItemKey(text: string, source: string): string {
    return `${text} [[${source}]]`.toLowerCase().trim();
  }

  formatOutputWithChecked(todos: TodoItem[], checkedItems: string[]): string {
    const checkedSet = new Set(checkedItems.map(item => item.toLowerCase().trim()));

    const activeTodos = todos.filter(todo => {
      const todoKey = this.getItemKey(todo.text, todo.sourceBasename);
      return !checkedSet.has(todoKey);
    });

    if (!this.settings.enableTimeGroups) {
      let output = '';

      for (const todo of activeTodos) {
        output += `- [ ] ${todo.text} [[${todo.sourceBasename}]]\n`;
      }

      if (this.settings.showCheckedSection && checkedItems.length > 0) {
        output += '\n\n\n\n\n\n\n\n---\n';
        output += `${this.settings.checkedSectionHeader}\n\n`;
        for (const item of checkedItems) {
          output += `- [x] ${item}\n`;
        }
      }

      return output;
    }

    const groups: Record<TimeGroup, GroupedItem[]> = {
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

    const groupOrder: TimeGroup[] = ['today', 'tomorrow', 'week', 'backlog'];

    for (const group of groupOrder) {
      const order = this.itemOrder[group];
      if (order.length > 0) {
        groups[group].sort((a, b) => {
          const indexA = order.indexOf(a.key);
          const indexB = order.indexOf(b.key);
          const posA = indexA === -1 ? Infinity : indexA;
          const posB = indexB === -1 ? Infinity : indexB;
          return posA - posB;
        });
      }
    }

    let output = '';

    for (const group of groupOrder) {
      const count = groups[group].length;
      const countStr = count > 0 ? ` (${count})` : '';
      output += `## ${TIME_GROUP_HEADERS[group]}${countStr}\n`;
      if (count > 0) {
        output += groups[group].map(item => item.line).join('\n') + '\n';
      }
      output += '\n';
    }

    if (this.settings.showCheckedSection && checkedItems.length > 0) {
      // Filter and format completed items with decay countdown
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const decayEnabled = this.settings.decayDays > 0;
      const activeCheckedItems: { item: string; daysLeft: number }[] = [];

      for (const item of checkedItems) {
        const itemKey = item.toLowerCase().trim();

        if (!decayEnabled) {
          // Never decay - just show all items
          activeCheckedItems.push({ item, daysLeft: -1 });
          continue;
        }

        const completedAt = this.completedTimestamps[itemKey];

        if (completedAt) {
          const daysSinceCompleted = Math.floor((now - completedAt) / dayMs);
          const daysLeft = this.settings.decayDays - daysSinceCompleted;

          if (daysLeft > 0) {
            activeCheckedItems.push({ item, daysLeft });
          } else {
            // Item has decayed, clean up timestamp
            delete this.completedTimestamps[itemKey];
          }
        } else {
          // No timestamp yet, add it now (for existing items)
          this.completedTimestamps[itemKey] = now;
          activeCheckedItems.push({ item, daysLeft: this.settings.decayDays });
        }
      }

      if (activeCheckedItems.length > 0) {
        output += '\n\n---\n';
        output += `${this.settings.checkedSectionHeader}\n\n`;
        for (const { item, daysLeft } of activeCheckedItems) {
          if (this.settings.showDecayCountdown && decayEnabled && daysLeft > 0) {
            const daysText = daysLeft === 1 ? '1 day left' : `${daysLeft} days left`;
            output += `- [x] ${item} (${daysText})\n`;
          } else {
            output += `- [x] ${item}\n`;
          }
        }
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

    new Setting(containerEl)
      .setName('Output file path')
      .setDesc('Path to the file where todos will be collected (relative to vault root).')
      .addText(text => text
        .setPlaceholder('Todos.md')
        .setValue(this.plugin.settings.outputFilePath)
        .onChange(async (value) => {
          this.plugin.settings.outputFilePath = value || 'TODOs.md';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('Comma-separated list of folders to skip (e.g., templates, archive).')
      .addText(text => text
        .setPlaceholder('Templates, archive')
        .setValue(this.plugin.settings.excludeFolders.join(', '))
        .onChange(async (value) => {
          this.plugin.settings.excludeFolders = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
          await this.plugin.saveSettings();
          await this.plugin.collectAndWriteTodos();
        }));

    new Setting(containerEl)
      .setName('Pin to top of sidebar')
      .setDesc('Keep the todo file pinned to the top of the file explorer.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.pinToTop)
        .onChange(async (value) => {
          this.plugin.settings.pinToTop = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Time-based groups')
      .setDesc('Organize todos into sections: today, tomorrow, next 7 days, backlog. Drag items between sections in reading mode.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTimeGroups)
        .onChange(async (value) => {
          this.plugin.settings.enableTimeGroups = value;
          await this.plugin.saveSettings();
          await this.plugin.collectAndWriteTodos();
        }));

    new Setting(containerEl)
      .setName('Show checked section')
      .setDesc('When you check off a todo, move it to a collapsible section.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showCheckedSection)
        .onChange(async (value) => {
          this.plugin.settings.showCheckedSection = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Checked section header')
      .setDesc('Text to show above completed items.')
      .addText(text => text
        .setPlaceholder('Completed')
        .setValue(this.plugin.settings.checkedSectionHeader)
        .onChange(async (value) => {
          this.plugin.settings.checkedSectionHeader = value || 'Completed';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Decay days')
      .setDesc('Days before completed tasks are removed from the list.')
      .addDropdown(dropdown => dropdown
        .addOptions({
          '1': '1 day',
          '2': '2 days',
          '3': '3 days',
          '5': '5 days',
          '7': '7 days',
          '14': '14 days',
          '0': 'Never'
        })
        .setValue(String(this.plugin.settings.decayDays))
        .onChange(async (value) => {
          this.plugin.settings.decayDays = parseInt(value);
          await this.plugin.saveSettings();
          await this.plugin.collectAndWriteTodos();
        }));

    new Setting(containerEl)
      .setName('Show decay countdown')
      .setDesc('Show days remaining next to completed tasks.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showDecayCountdown)
        .onChange(async (value) => {
          this.plugin.settings.showDecayCountdown = value;
          await this.plugin.saveSettings();
          await this.plugin.collectAndWriteTodos();
        }));
  }
}
