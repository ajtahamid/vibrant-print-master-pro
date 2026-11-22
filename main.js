// Vibrant Print Master Pro — main process. Created by Tahamid.
import { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { initColor, listCmykProfiles, setProfile, profileInfo, cmykToRgb, rgbToCmyk } from './core/color.js';
import { scanFonts, shapeLine, bengaliFallback, coversBengali, pdfGlyphs } from './core/fonts.js';
import { resolveDisplayList, writePdf, writeEps, writeFileSafe } from './core/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'Vibrant Print Master Pro';
app.setName(APP_NAME);

protocol.registerSchemesAsPrivileged([
  { scheme: 'vpm', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { profilePath: null, units: 'mm', recent: [] };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}

let profiles = [];
async function initProfiles() {
  await initColor();
  profiles = await listCmykProfiles(__dirname);
  let chosen = profiles.find((p) => p.path === settings.profilePath) || profiles[0];
  if (chosen) await setProfile(chosen.path);
}

const windows = new Set();
function createWindow(openFile) {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640,
    title: APP_NAME,
    backgroundColor: '#1e1f22',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  win.loadURL('vpm://app/renderer/index.html' + (openFile ? '?open=' + encodeURIComponent(openFile) : ''));
  win.on('close', (e) => {
    if (win.__forceClose) return;
    e.preventDefault();
    win.webContents.send('menu', 'window-close-request');
  });
  return win;
}

const send = (cmd) => (item, win) => { (win || BrowserWindow.getFocusedWindow())?.webContents.send('menu', cmd); };

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { label: 'About ' + APP_NAME, click: send('about') },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: send('preferences') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New…', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Alt+N', click: () => createWindow() },
        { label: 'Open…  (.vpm, .ai, .pdf, .svg)', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { label: 'Place Image…', accelerator: 'CmdOrCtrl+Shift+P', click: send('place') },
        { label: 'Import SVG / AI / PDF…', click: send('import-svg') },
        { type: 'separator' },
        { label: 'Export Print PDF…', accelerator: 'CmdOrCtrl+Alt+P', click: send('export-pdf') },
        { label: 'Save as Illustrator (.ai)…', accelerator: 'CmdOrCtrl+Alt+A', click: send('export-ai') },
        { label: 'Save as EPS…', accelerator: 'CmdOrCtrl+Alt+E', click: send('export-eps') },
        { label: 'Export PNG / JPG…', accelerator: 'CmdOrCtrl+Alt+Shift+W', click: send('export-raster') },
        { label: 'Export SVG…', click: send('export-svg') },
        { type: 'separator' },
        { label: 'Preflight Check', accelerator: 'CmdOrCtrl+Shift+F', click: send('preflight') },
        { label: 'Document Setup…', accelerator: 'CmdOrCtrl+Alt+D', click: send('doc-setup') },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: send('window-close-request') },
        ...(isMac ? [] : [{ label: 'Preferences…', accelerator: 'Ctrl+,', click: send('preferences') }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Paste in Place', accelerator: 'CmdOrCtrl+Shift+V', click: send('paste-in-place') },
        { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: send('duplicate') },
        { label: 'Delete', click: send('delete') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: send('select-all') },
        { label: 'Deselect', accelerator: 'CmdOrCtrl+Shift+A', click: send('deselect') },
      ],
    },
    {
      label: 'Object',
      submenu: [
        { label: 'Group', accelerator: 'CmdOrCtrl+G', click: send('group') },
        { label: 'Ungroup', accelerator: 'CmdOrCtrl+Shift+G', click: send('ungroup') },
        { type: 'separator' },
        { label: 'Bring to Front', accelerator: 'CmdOrCtrl+Shift+]', click: send('front') },
        { label: 'Bring Forward', accelerator: 'CmdOrCtrl+]', click: send('forward') },
        { label: 'Send Backward', accelerator: 'CmdOrCtrl+[', click: send('backward') },
        { label: 'Send to Back', accelerator: 'CmdOrCtrl+Shift+[', click: send('back') },
        { type: 'separator' },
        { label: 'Lock Selection', accelerator: 'CmdOrCtrl+2', click: send('lock') },
        { label: 'Unlock All', accelerator: 'CmdOrCtrl+Alt+2', click: send('unlock-all') },
        { label: 'Hide Selection', accelerator: 'CmdOrCtrl+3', click: send('hide') },
        { label: 'Show All', accelerator: 'CmdOrCtrl+Alt+3', click: send('show-all') },
        { type: 'separator' },
        { label: 'Make Clipping Mask', accelerator: 'CmdOrCtrl+7', click: send('clip-make') },
        { label: 'Release Clipping Mask', accelerator: 'CmdOrCtrl+Alt+7', click: send('clip-release') },
        { type: 'separator' },
        { label: 'Convert to Path', click: send('to-path') },
        { label: 'Flip Horizontal', click: send('flip-h') },
        { label: 'Flip Vertical', click: send('flip-v') },
      ],
    },
    {
      label: 'Type',
      submenu: [
        { label: 'Create Outlines', accelerator: 'CmdOrCtrl+Shift+O', click: send('outline-text') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Fit Artboard in Window', accelerator: 'CmdOrCtrl+0', click: send('zoom-fit') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+1', click: send('zoom-100') },
        { type: 'separator' },
        { label: 'Show/Hide Rulers', accelerator: 'CmdOrCtrl+R', click: send('toggle-rulers') },
        { label: 'Show/Hide Guides', accelerator: 'CmdOrCtrl+;', click: send('toggle-guides') },
        { label: 'Show/Hide Bleed & Safe Area', click: send('toggle-bleed') },
        { label: 'Snap to Guides & Objects', type: 'checkbox', checked: true, click: send('toggle-snap') },
        { label: 'Clear Guides', click: send('clear-guides') },
        { type: 'separator' },
        { label: 'Overprint-style CMYK Preview (approximate)', enabled: false },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: (i, w) => w?.webContents.toggleDevTools() },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: send('shortcuts') },
        { label: 'About ' + APP_NAME, click: send('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('color:profiles', () => ({ list: profiles, current: profileInfo() }));
  ipcMain.handle('color:set-profile', async (e, p) => {
    const name = await setProfile(p);
    settings.profilePath = p; saveSettings();
    return name;
  });
  ipcMain.handle('color:cmyk-to-rgb', (e, list) => cmykToRgb(list));
  ipcMain.handle('color:rgb-to-cmyk', (e, list) => rgbToCmyk(list));

  ipcMain.handle('fonts:list', async () => (await scanFonts(path.join(app.getPath('userData'), 'font-cache.json'))).map((f) => ({
    id: f.id, family: f.family, style: f.style, postscript: f.postscript, fullName: f.fullName, weight: f.weight, italic: f.italic,
  })));
  ipcMain.handle('fonts:bn', (e, id) => ({ fallback: bengaliFallback(), covers: id ? coversBengali(id) : null }));
  ipcMain.handle('fonts:pdf-glyphs', (e, req) => pdfGlyphs(req));
  ipcMain.handle('fonts:shape', (e, { fontId, text, size, tracking }) => shapeLine(fontId, text, size, tracking));

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (e, s) => { settings = { ...settings, ...s }; saveSettings(); return settings; });

  ipcMain.handle('dialog:open', async (e, opts) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), opts);
    return r.canceled ? null : r.filePaths;
  });
  ipcMain.handle('dialog:save', async (e, opts) => {
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), opts);
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('dialog:confirm', async (e, opts) => {
    const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), opts);
    return r.response;
  });
  ipcMain.handle('fs:read-text', (e, p) => fs.readFileSync(p, 'utf8'));
  ipcMain.handle('fs:read-bin', (e, p) => fs.readFileSync(p));
  ipcMain.handle('fs:write-text', (e, p, data) => { writeFileSafe(p, Buffer.from(data, 'utf8')); addRecent(p); return true; });
  ipcMain.handle('fs:write-bin', (e, p, data) => { writeFileSafe(p, Buffer.from(data)); return true; });

  ipcMain.handle('export:print', async (e, { format, file, pages, opts }) => {
    const t0 = Date.now();
    const resolved = pages.map((p) => ({ ...p, items: resolveDisplayList(p.items, format === 'eps') }));
    let buf;
    if (format === 'eps') buf = writeEps(resolved[0], opts);
    else buf = writePdf(resolved, { ...opts, mode: format });
    writeFileSafe(file, buf);
    return { bytes: buf.length, ms: Date.now() - t0 };
  });
  ipcMain.handle('shell:reveal', (e, p) => shell.showItemInFolder(p));
  ipcMain.on('window:force-close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { w.__forceClose = true; w.close(); } });
  ipcMain.on('window:set-title', (e, t, edited) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    w.setTitle(t);
    if (process.platform === 'darwin') w.setDocumentEdited(!!edited);
  });
}

function addRecent(p) {
  if (!/\.vpm$/i.test(p)) return;
  settings.recent = [p, ...(settings.recent || []).filter((x) => x !== p)].slice(0, 10);
  saveSettings();
  if (process.platform === 'darwin') app.addRecentDocument(p);
}

let pendingOpen = null;
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (app.isReady()) createWindow(p); else pendingOpen = p;
});

app.whenReady().then(async () => {
  protocol.handle('vpm', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.join(__dirname, rel);
    if (!file.startsWith(__dirname)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  loadSettings();
  await initProfiles();
  registerIpc();
  buildMenu();
  scanFonts(path.join(app.getPath('userData'), 'font-cache.json')).catch(() => {});
  if (process.env.VPM_TEST) {
    const { runTest } = await import('./scratch/test-main.js');
    runTest(createWindow);
    return;
  }
  createWindow(pendingOpen);
  app.on('activate', () => { if (windows.size === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
