import path from 'path';
import debounce from 'lodash/debounce';
import osLocale from 'os-locale';
import { machineId } from 'node-machine-id';
import tar from 'tar';
import got from 'got';
import fse from 'fs-extra';

import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  screen,
  Tray,
  nativeImage,
  nativeTheme,
  dialog,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import contextMenu from 'electron-context-menu';
import unhandled from 'electron-unhandled';
import debug from 'electron-debug';

import electronLogger from 'electron-log';

import { IPopupEventData, IRuneItem } from '@interfaces/commonTypes';
import { initLogger } from './utils/logger';
import { appConfig } from './utils/config';
import { ifIsCNServer, LcuWatcher } from './utils/lcu';
import { LanguageList, LanguageSet } from './constants/langs';
import { LcuEvent } from './constants/events';
import { LcuWsClient } from './utils/ws';
import { hasPwsh } from './utils/cmd';
import { bufferToStream, getAllFileContent, removeFolderContent, saveToFile, updateDirStats } from './utils/file';
import { sleep } from './utils/index';
import { nanoid } from 'nanoid';

const isMac = process.platform === 'darwin';
const isDev = process.env.IS_DEV_MODE === `true`;
initLogger();

unhandled({
  showDialog: false,
});
debug({
  showDevTools: false,
});
contextMenu();

process.env[`NODE_TLS_REJECT_UNAUTHORIZED`] = `0`;
nativeTheme.themeSource = `light`;
// Note: Must match `build.appId` in package.json
app.setAppUserModelId('com.al.champ-r');
app.commandLine.appendSwitch('ignore-certificate-errors', 'true');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

const ignoreSystemScale = appConfig.get(`ignoreSystemScale`);
if (ignoreSystemScale) {
  app.commandLine.appendSwitch('high-dpi-support', `1`);
  app.commandLine.appendSwitch('force-device-scale-factor', `1`);
}

// Prevent window from being garbage collected
let mainWindow: BrowserWindow | null;
let popupWindow: BrowserWindow | null;
let tray: Tray | null = null;
let lcuWatcher: LcuWatcher | null = null;

const webPreferences = {
  webSecurity: false,
  nodeIntegration: true,
  contextIsolation: true,
  enableRemoteModule: true,
  allowRunningInsecureContent: true,
  zoomFactor: 1,
  preload: path.join(__dirname, 'preload.js'),
};

const createMainWindow = async () => {
  const startMinimized = appConfig.get(`startMinimized`, false);

  const win = new BrowserWindow({
    title: app.name,
    center: true,
    show: false,
    frame: false,
    height: 650,
    width: 400,
    resizable: isDev || ignoreSystemScale,
    webPreferences,
  });

  win.on('ready-to-show', () => {
    if (startMinimized) {
      console.log(`started ChampR minimized`);
      win.setSkipTaskbar(true);
      return;
    }

    win.show();
  });

  win.on('closed', () => {
    // Dereference the window
    // For multiple windows, store them in an array
    mainWindow = null;
    popupWindow = null;
  });

  await win.loadURL(
    isDev ? 'http://127.0.0.1:3000' : `file://${path.join(__dirname, 'index.html')}`,
  );

  return win;
};

const createPopupWindow = async () => {
  const [mX, mY] = mainWindow!.getPosition();
  const curDisplay = screen.getDisplayNearestPoint({
    x: mX,
    y: mY,
  });

  const popupConfig = appConfig.get(`popup`);
  const popup = new BrowserWindow({
    show: false,
    frame: false,
    resizable: true,
    fullscreenable: false,

    skipTaskbar: popupConfig.alwaysOnTop,
    alwaysOnTop: popupConfig.alwaysOnTop,
    width: popupConfig.width || 300,
    height: popupConfig.height || 350,
    x: popupConfig.x || (isDev ? curDisplay.bounds.width / 2 : curDisplay.bounds.width - 500 - 140),
    y: popupConfig.y || curDisplay.bounds.height / 2,
    webPreferences,
  });

  popup.on(
    `move`,
    debounce(() => persistPopUpBounds(popup), 1000),
  );

  popup.on(
    `resize`,
    debounce(() => persistPopUpBounds(popup), 1000),
  );

  popup.on('closed', () => {
    popupWindow = null;
  });

  await popup.loadURL(
    isDev ? `http://127.0.0.1:3000/popup.html` : `file://${path.join(__dirname, 'popup.html')}`,
  );

  return popup;
};

// Prevent multiple instances of the app
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
  }
});

app.on(`quit`, () => {
  mainWindow = null;
  popupWindow = null;
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});

app.on('activate', async () => {
  if (!mainWindow) {
    mainWindow = await createMainWindow();
  }
});

function persistPopUpBounds(w: BrowserWindow) {
  if (!w) {
    return;
  }

  const { x, y, width, height } = w.getBounds();
  appConfig.set(`popup.x`, x);
  appConfig.set(`popup.y`, y);
  appConfig.set(`popup.width`, width);
  appConfig.set(`popup.height`, height);
}

let lastChampion = 0;

async function onShowPopup(data: IPopupEventData) {
  if (data.noCache) lastChampion = 0;

  if (!data.championId || lastChampion === data.championId) {
    return;
  }

  lastChampion = data.championId;
  if (!popupWindow) {
    popupWindow = await createPopupWindow();
  }

  // popupWindow.setAlwaysOnTop(true);
  popupWindow.show();
  // popupWindow.setAlwaysOnTop(false);
  // app.focus();
  popupWindow.focus();

  const task = setInterval(() => {
    if (!popupWindow!.isVisible()) {
      return;
    }

    popupWindow!.webContents.send(`for-popup`, {
      championId: data.championId,
    });
    clearInterval(task);
  }, 300);
}

function updateStatusForMainWindowWebView(data: any) {
  mainWindow?.webContents.send(`apply_builds_process`, {
    data,
    id: nanoid(),
  });
}

function registerMainListeners() {
  ipcMain.on(`toggle-main-window`, () => {
    toggleMainWindow();
  });

  ipcMain.on(`restart-app`, () => {
    app.relaunch();
    app.exit();
  });

  ipcMain.on(`popup:toggle-always-on-top`, () => {
    if (!popupWindow) return;

    const next = !popupWindow.isAlwaysOnTop();
    popupWindow.setAlwaysOnTop(next);
    popupWindow.setSkipTaskbar(next);

    appConfig.set(`popup.alwaysOnTop`, next);
  });

  ipcMain.on(`popup:reset-position`, () => {
    const [mx, my] = mainWindow!.getPosition();
    const { bounds } = screen.getDisplayNearestPoint({ x: mx, y: my });
    const [x, y] = [bounds.width / 2, bounds.height / 2];

    appConfig.set(`popup.alwaysOnTop`, true);
    appConfig.set(`popup.x`, x);
    appConfig.set(`popup.y`, y);

    if (!popupWindow) {
      return;
    }

    popupWindow.setAlwaysOnTop(true);
    popupWindow.setPosition(x, y);
  });

  ipcMain.on(`updateLolDir`, async (_ev, { lolDir }) => {
    console.info(`lolDir is ${lolDir}`);
    appConfig.set(`lolDir`, lolDir);
    if (!lolDir) {
      return;
    }
  });

  ipcMain.on(`request-for-auth-config`, () => {
    const lolDir = appConfig.get(`lolDir`);
    ifIsCNServer(lolDir);
  });

  ipcMain.on(`openSelectFolderDialog`, async (_, { jobId }: any) => {
    try {
      const data = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      mainWindow?.webContents.send(`openSelectFolderDialog:done:${jobId}`, {
        ...data,
        jobId,
      });
    } catch (e) {
      mainWindow?.webContents.send(`openSelectFolderDialog:reject:${jobId}`, e);
    }
  });

  ipcMain.on(`quit-app`, () => {
    app.quit();
  });

  ipcMain.on(`applyRunePage`, async (_ev, data: IRuneItem & { jobId: string }) => {
    try {
      await lcuWatcher?.applyRunePage(data);
      popupWindow!.webContents.send(`applyRunePage:done:${data.jobId}`);
    } catch (err) {
      console.error(`[main] apply perk failed: `, err.message);
    } finally {
      if (isDev) {
        popupWindow!.webContents.send(`applyRunePage:done:${data.jobId}`);
      }
    }
  });

  ipcMain.on(`showPopup`, (_ev, data: IPopupEventData) => {
    onShowPopup(data);
  });

  ipcMain.on(`hidePopup`, () => {
    popupWindow?.hide();
  });

  ipcMain.on(`PrepareSourceData`, async (_ev, source) => {
    let url = `https://registry.npmjs.com/@champ-r/${source}/latest`;
    let cwd = `.npm/${source}/`;
    let lolDir = appConfig.get(`lolDir`);

    try {
      let { dist: { tarball } } = await got(url, {
        responseType: `json`,
      }).json();
      updateStatusForMainWindowWebView({
        source,
        msg: `Fetched metadata for ${source}`,
      });
      console.log(`[npm] downloading tarball for ${source}`);
      updateStatusForMainWindowWebView({
        source,
        msg: `Downloading tarball for ${source}`,
      });
      let { body } = await got(tarball, {
        responseType: 'buffer',
      });
      console.log(`[npm] tarball downloaded, ${source}`);
      updateStatusForMainWindowWebView({
        source,
        msg: `Downloaded tarball for ${source}`,
      });
      let s = bufferToStream(body);
      await fse.ensureDir(cwd);
      console.log(`[npm] extracting to ${cwd}`);
      s.pipe(
        tar.x({
          strip: 1,
          cwd,
        }),
      );
      console.log(`[npm] extracted to ${cwd}`);
      updateStatusForMainWindowWebView({
        source,
        msg: `Extracted data for ${source}`,
      });
      await sleep(3000);
      await updateDirStats(cwd);
      let files = await getAllFileContent(cwd);
      let tasks: any[] = [];
      files.forEach(arr => {
        arr.forEach(i => {
          const { position, itemBuilds } = i;
          const pStr = position ? `${position} - ` : ``;
          itemBuilds.forEach((k, idx) => {
            let champion = i.alias;
            const file = {
              ...k,
              champion,
              position,
              fileName: `[${source.toUpperCase()}] ${pStr}${champion}-${idx + 1}`,
            };
            let task = saveToFile(lolDir, file, true, 0)
              .then((result) => {
                if (result instanceof Error) {
                  console.error(`failed: `, champion, position);
                  return;
                }

                console.log(`done: `, champion, position);
                updateStatusForMainWindowWebView({
                  source,
                  champion,
                  position,
                  msg: `[${source}] Applied builds for ${position ? champion + `@` + position : champion}`,
                });
              });
            tasks.push(task);
          });
        });
      });
      await Promise.all(tasks);
      updateStatusForMainWindowWebView({
        source,
        finished: true,
        msg: `[${source}] Finished.`,
      });
    } catch (e) {
      console.error(source, e);
      updateStatusForMainWindowWebView({
        source,
        error: true,
        e,
        msg: `[${source}] Something went wrong`,
      });
    }
  });

  ipcMain.on(`EmptyBuildsFolder`, async (_ev, { jobId }) => {
    let lolDir = appConfig.get(`lolDir`);
    await Promise.all([
      removeFolderContent(`${lolDir}/Game/Config/Champions`),
      removeFolderContent(`${lolDir}/Config/Champions`),
    ]);
    mainWindow?.webContents.send(`EmptyBuildsFolder:done:${jobId}`);
  });
}

function toggleMainWindow() {
  if (!mainWindow) {
    return;
  }

  const visible = mainWindow.isVisible();
  if (!visible) {
    mainWindow.show();
    mainWindow.setSkipTaskbar(false);
  } else {
    mainWindow.hide();
    mainWindow.setSkipTaskbar(true);
  }
}

interface ITrayOptions {
  minimized?: boolean;
}

function makeTray({ minimized = false }: ITrayOptions) {
  const iconPath = path.join(
    isDev ? `${__dirname}/../` : process.resourcesPath,
    'resources/app-icon.png',
  );
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });

  tray = new Tray(icon);
  // tray.setIgnoreDoubleClickEvents(true)
  tray.setToolTip('ChampR');
  tray.on(`click`, () => {
    toggleMainWindow();
  });
  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Toggle window`,
      click() {
        toggleMainWindow();
      },
    },
    {
      label: `Exit`,
      click() {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  if (minimized) {
    tray.displayBalloon({
      icon: iconPath,
      title: `ChampR`,
      content: `ChampR started minimized`,
    });
  }
}

async function getMachineId() {
  const userId = appConfig.get(`userId`);
  if (userId) return userId;

  const id = await machineId();
  appConfig.set(`userId`, id);
  return id;
}

function isNetworkError(errorObject: Error) {
  return errorObject.message.includes(`net::ERR_`);
  // errorObject.message === 'net::ERR_INTERNET_DISCONNECTED' ||
  // errorObject.message === 'net::ERR_PROXY_CONNECTION_FAILED' ||
  // errorObject.message === 'net::ERR_CONNECTION_RESET' ||
  // errorObject.message === 'net::ERR_CONNECTION_CLOSE' ||
  // errorObject.message === 'net::ERR_NAME_NOT_RESOLVED' ||
  // errorObject.message === 'net::ERR_CONNECTION_TIMED_OUT' ||
  // errorObject.message === 'net::ERR_EMPTY_RESPONSE'
}

async function checkUpdates() {
  if (isDev) {
    console.log(`Skipped updated check for dev mode.`);
    return;
  }

  try {
    setInterval(async () => {
      await autoUpdater.checkForUpdates();
    }, 1000 * 60 * 60 * 4);

    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (isNetworkError(err)) {
      console.error('Network Error');
      return;
    }

    console.error(err == null ? 'unknown' : (err.stack || err).toString());
  }
}

function registerUpdater() {
  electronLogger.transports.file.level = 'info';
  autoUpdater.logger = electronLogger;
  autoUpdater.autoDownload = false;

  autoUpdater.on('checking-for-update', () => {
    console.log(`Checking update...`);
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`${info.version}`);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send(`update-available`, info);
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.error(`Update not available: ${info.version}`);
  });

  autoUpdater.on(`update-downloaded`, (info) => {
    console.info(`Update downloaded: ${info.version}`);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send(`update-downloaded`, info);
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Error in auto-updater. ' + err);
  });

  ipcMain.on(`install-update`, () => {
    autoUpdater.quitAndInstall(false);
  });
}

(async () => {
  console.log(`ChampR starting, app version ${app.getVersion()}.`);

  await app.whenReady();
  Menu.setApplicationMenu(null);

  let locale = await osLocale();
  let appLang = appConfig.get(`appLang`);
  console.info(`System locale is ${locale}, app lang is ${appLang || 'unset'}`);

  if (!appLang) {
    if (LanguageList.includes(locale)) {
      appConfig.set(`appLang`, locale);
    } else {
      appConfig.set(`appLang`, LanguageSet.enUS);
    }
  }
  const minimized = appConfig.get(`startMinimized`, false);

  const pwsh = await hasPwsh();
  lcuWatcher = new LcuWatcher(pwsh);
  const lcuWs = new LcuWsClient(lcuWatcher);

  mainWindow = await createMainWindow();
  popupWindow = await createPopupWindow();

  lcuWatcher.addListener(LcuEvent.SelectedChampion, (data: IPopupEventData) => {
    onShowPopup(data);
  });
  lcuWatcher.addListener(LcuEvent.MatchedStartedOrTerminated, () => {
    if (popupWindow) {
      lastChampion = 0;
      const isVisible = popupWindow.isVisible();
      if (isVisible) {
        popupWindow.hide();
      }
    }
  });

  registerMainListeners();
  registerUpdater();

  await makeTray({ minimized });

  const userId = await getMachineId();

  console.log(`userId: ${userId}`);
  await checkUpdates();
})();
