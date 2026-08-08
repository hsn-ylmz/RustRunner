/**
 * Application Menu Builder
 *
 * Creates platform-specific application menus with keyboard shortcuts.
 */

import {
  app,
  Menu,
  shell,
  BrowserWindow,
  MenuItemConstructorOptions,
} from 'electron';

import { checkForUpdatesManually } from './updater';

interface DarwinMenuItemConstructorOptions extends MenuItemConstructorOptions {
  selector?: string;
  submenu?: DarwinMenuItemConstructorOptions[] | Menu;
}

/** Repository the Help menu links to. */
const REPO_URL = 'https://github.com/hsn-ylmz/RustRunner';

/**
 * Actions the menu forwards to the renderer over the 'menu-action' channel.
 * These can't be handled in the main process — the workflow lives in renderer
 * state — so the menu is a thin dispatcher.
 */
export type MenuAction =
  | 'new'
  | 'open'
  | 'save'
  | 'save-as'
  | 'undo'
  | 'redo';

export default class MenuBuilder {
  mainWindow: BrowserWindow;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  /** Forwards a menu selection to the renderer. */
  private send(action: MenuAction): void {
    this.mainWindow.webContents.send('menu-action', action);
  }

  /**
   * File submenu. Shared by both platform templates so New/Open/Save behave
   * identically everywhere — previously the Windows/Linux entries declared
   * accelerators but had no click handler, so Ctrl+N/O/S silently did nothing.
   */
  private buildFileSubmenu(isDarwin: boolean): MenuItemConstructorOptions {
    const mod = isDarwin ? 'Command' : 'Ctrl';

    return {
      label: isDarwin ? 'File' : '&File',
      submenu: [
        {
          label: 'New Workflow',
          accelerator: `${mod}+N`,
          click: () => this.send('new'),
        },
        {
          label: 'Open…',
          accelerator: `${mod}+O`,
          click: () => this.send('open'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: `${mod}+S`,
          click: () => this.send('save'),
        },
        {
          label: 'Save As…',
          accelerator: `Shift+${mod}+S`,
          click: () => this.send('save-as'),
        },
        { type: 'separator' },
        {
          label: 'Close',
          accelerator: `${mod}+W`,
          click: () => this.mainWindow.close(),
        },
      ],
    };
  }

  buildMenu(): Menu {
    if (
      process.env.NODE_ENV === 'development' ||
      process.env.DEBUG_PROD === 'true'
    ) {
      this.setupDevelopmentEnvironment();
    }

    const template =
      process.platform === 'darwin'
        ? this.buildDarwinTemplate()
        : this.buildDefaultTemplate();

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    return menu;
  }

  setupDevelopmentEnvironment(): void {
    this.mainWindow.webContents.on('context-menu', (_, props) => {
      const { x, y } = props;

      Menu.buildFromTemplate([
        {
          label: 'Inspect element',
          click: () => {
            this.mainWindow.webContents.inspectElement(x, y);
          },
        },
      ]).popup({ window: this.mainWindow });
    });
  }

  buildDarwinTemplate(): MenuItemConstructorOptions[] {
    const subMenuAbout: DarwinMenuItemConstructorOptions = {
      label: 'RustRunner',
      submenu: [
        {
          label: 'About RustRunner',
          selector: 'orderFrontStandardAboutPanel:',
        },
        { type: 'separator' },
        { label: 'Services', submenu: [] },
        { type: 'separator' },
        {
          label: 'Hide RustRunner',
          accelerator: 'Command+H',
          selector: 'hide:',
        },
        {
          label: 'Hide Others',
          accelerator: 'Command+Shift+H',
          selector: 'hideOtherApplications:',
        },
        { label: 'Show All', selector: 'unhideAllApplications:' },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'Command+Q',
          click: () => app.quit(),
        },
      ],
    };

    const subMenuEdit: DarwinMenuItemConstructorOptions = {
      label: 'Edit',
      submenu: [
        // Routed to the renderer rather than the native `undo:` selector,
        // which only ever reached text fields and left canvas edits
        // (add / delete / connect / clear) with no undo at all. The renderer
        // falls back to text-field undo when a field has focus.
        {
          label: 'Undo',
          accelerator: 'Command+Z',
          click: () => this.send('undo'),
        },
        {
          label: 'Redo',
          accelerator: 'Shift+Command+Z',
          click: () => this.send('redo'),
        },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'Command+X', selector: 'cut:' },
        { label: 'Copy', accelerator: 'Command+C', selector: 'copy:' },
        { label: 'Paste', accelerator: 'Command+V', selector: 'paste:' },
        { label: 'Select All', accelerator: 'Command+A', selector: 'selectAll:' },
      ],
    };

    const subMenuView: MenuItemConstructorOptions = {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'Command+R',
          click: () => this.mainWindow.webContents.reload(),
        },
        {
          label: 'Toggle Full Screen',
          accelerator: 'Ctrl+Command+F',
          click: () => this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen()),
        },
        ...(process.env.NODE_ENV === 'development' ||
        process.env.DEBUG_PROD === 'true'
          ? [
              {
                label: 'Toggle Developer Tools',
                accelerator: 'Alt+Command+I',
                click: () => this.mainWindow.webContents.toggleDevTools(),
              },
            ]
          : []),
      ],
    };

    const subMenuWindow: DarwinMenuItemConstructorOptions = {
      label: 'Window',
      submenu: [
        {
          label: 'Minimize',
          accelerator: 'Command+M',
          selector: 'performMiniaturize:',
        },
        { label: 'Close', accelerator: 'Command+W', selector: 'performClose:' },
        { type: 'separator' },
        { label: 'Bring All to Front', selector: 'arrangeInFront:' },
      ],
    };

    const subMenuHelp: MenuItemConstructorOptions = {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => checkForUpdatesManually(),
        },
        { type: 'separator' },
        {
          label: 'Documentation',
          click() {
            shell.openExternal(REPO_URL);
          },
        },
        {
          label: 'Report Issue',
          click() {
            shell.openExternal(`${REPO_URL}/issues`);
          },
        },
      ],
    };

    return [
      subMenuAbout,
      this.buildFileSubmenu(true),
      subMenuEdit,
      subMenuView,
      subMenuWindow,
      subMenuHelp,
    ];
  }

  buildDefaultTemplate(): MenuItemConstructorOptions[] {
    return [
      this.buildFileSubmenu(false),
      {
        label: '&Edit',
        submenu: [
          { label: '&Undo', accelerator: 'Ctrl+Z', click: () => this.send('undo') },
          {
            label: '&Redo',
            accelerator: 'Shift+Ctrl+Z',
            click: () => this.send('redo'),
          },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '&View',
        submenu: [
          {
            label: '&Reload',
            accelerator: 'Ctrl+R',
            click: () => this.mainWindow.webContents.reload(),
          },
          {
            label: 'Toggle &Full Screen',
            accelerator: 'F11',
            click: () => this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen()),
          },
          ...(process.env.NODE_ENV === 'development' ||
          process.env.DEBUG_PROD === 'true'
            ? [
                {
                  label: 'Toggle &Developer Tools',
                  accelerator: 'Alt+Ctrl+I',
                  click: () => this.mainWindow.webContents.toggleDevTools(),
                },
              ]
            : []),
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Check for Updates…',
            click: () => checkForUpdatesManually(),
          },
          { type: 'separator' },
          {
            label: 'Documentation',
            click() {
              shell.openExternal(REPO_URL);
            },
          },
          {
            label: 'Report Issue',
            click() {
              shell.openExternal(`${REPO_URL}/issues`);
            },
          },
        ],
      },
    ];
  }
}
