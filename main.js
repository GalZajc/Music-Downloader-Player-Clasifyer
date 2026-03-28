const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execSync, spawn } = require('child_process');

let mainWindow;

const YT_DLP_BROWSER_PROFILES = ['brave', 'brave:Profile 3', 'brave:Profile 4', 'brave:Default', 'edge'];

function getLocalCookiesFile() {
  const localCookies = [
    path.join(__dirname, 'Cookies', 'cookies.txt'),
    path.join(__dirname, 'cookies.txt'),
    path.join(process.cwd(), 'cookies.txt')
  ];

  for (const candidate of localCookies) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isCookieRelatedYtDlpError(errText) {
  const raw = (errText || '').toLowerCase();
  return raw.includes('confirm your age') ||
    raw.includes('age-restricted') ||
    raw.includes('sign in to confirm your age') ||
    raw.includes('sign in to youtube') ||
    raw.includes('login required') ||
    raw.includes("confirm you're not a bot") ||
    raw.includes('cookie') ||
    raw.includes('decrypt');
}

function getYtDlpCredentialAttempts() {
  const attempts = [{ type: 'none', label: 'without cookies', args: [] }];
  const cookiesFilePath = getLocalCookiesFile();

  if (cookiesFilePath) {
    attempts.push({ type: 'file', label: cookiesFilePath, args: ['--cookies', cookiesFilePath] });
  }

  for (const profile of YT_DLP_BROWSER_PROFILES) {
    attempts.push({ type: 'browser', label: profile, args: ['--cookies-from-browser', profile] });
  }

  return attempts;
}

function getYtDlpSharedArgs() {
  return ['--js-runtimes', 'node', '--remote-components', 'ejs:github', '--no-check-certificate', '--no-update'];
}

function formatYtDlpError(result) {
  return (result.stderr || result.stdout || result.error || `Exit code ${result.code}`).trim();
}

function runPythonYtDlp(args) {
  return new Promise((resolve) => {
    const proc = spawn('python', ['-m', 'yt_dlp', ...args], { shell: false, env: process.env });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => stdout += data.toString());
    proc.stderr.on('data', (data) => stderr += data.toString());

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        code,
        stdout,
        stderr,
        error: code === 0 ? '' : formatYtDlpError({ code, stdout, stderr, error: '' })
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        code: null,
        stdout,
        stderr,
        error: err.message
      });
    });
  });
}

function updateYtDlpOnStartup() {
  console.log('[Startup] Checking for yt-dlp updates...');

  const args = ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'yt-dlp'];
  const proc = spawn('python', args, { shell: false, env: process.env });
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (data) => stdout += data.toString());
  proc.stderr.on('data', (data) => stderr += data.toString());

  proc.on('close', (code) => {
    const combinedOutput = `${stdout}\n${stderr}`;

    if (code !== 0) {
      console.warn(`[Startup] yt-dlp update check failed with code ${code}.`);
      if (combinedOutput.trim()) {
        console.warn(combinedOutput.trim());
      }
      return;
    }

    if (combinedOutput.includes('Successfully installed yt-dlp')) {
      console.log('[Startup] yt-dlp was updated successfully.');
    } else if (combinedOutput.includes('Requirement already satisfied: yt-dlp')) {
      console.log('[Startup] yt-dlp is already up to date.');
    } else {
      console.log('[Startup] yt-dlp update check finished.');
      if (combinedOutput.trim()) {
        console.log(combinedOutput.trim());
      }
    }
  });

  proc.on('error', (err) => {
    console.warn('[Startup] Could not start yt-dlp update check:', err.message);
  });
}

function getAppIconPath() {
  const candidates = [
    path.join(__dirname, 'app-icon.ico'),
    path.join(__dirname, 'App Icon.ico'),
    path.join(__dirname, 'app-icon.png'),
    path.join(__dirname, 'App Icon.png')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function createWindow() {
  const appIconPath = getAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  updateYtDlpOnStartup();
  Menu.setApplicationMenu(null); // Remove default menu bar
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('select-file', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('read-dir', async (event, dirPath) => {
  try {
    const files = fs.readdirSync(dirPath);
    return files;
  } catch (err) {
    console.error(err);
    return [];
  }
});

ipcMain.handle('save-config', async (event, config) => {
  const configPath = path.join(__dirname, 'Config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return true;
});

ipcMain.handle('load-config', async () => {
  const configPath = path.join(__dirname, 'Config.json');
  if (fs.existsSync(configPath)) {
    const data = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(data);
  }
  return null;
});

ipcMain.handle('save-csv', async (event, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    return null;
  } catch (err) {
    console.error(err);
    return null;
  }
});

ipcMain.handle('read-playlist-data', async () => {
  try {
    const dataPath = path.join(__dirname, 'YouTube_Backup_Data', 'playlist_data.json');
    if (fs.existsSync(dataPath)) {
      return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    }
    return null;
  } catch (err) {
    console.error('Error reading playlist data:', err);
    return null;
  }
});

ipcMain.handle('get-file-url', (event, filePath) => {
  try {
    return pathToFileURL(filePath).href;
  } catch (e) {
    return `file://${filePath.replace(/\\/g, '/')}`;
  }
});

ipcMain.handle('open-path', async (event, filePath) => {
  shell.openPath(filePath);
  return true;
});

ipcMain.handle('open-external', async (event, url) => {
  shell.openExternal(url);
  return true;
});

ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

ipcMain.handle('resolve-lnk', async (event, lnkPath) => {
  try {
    const escapedPath = lnkPath.replace(/'/g, "''");
    const command = `powershell -command "$sh = New-Object -ComObject WScript.Shell; $sh.CreateShortcut('${escapedPath}').TargetPath"`;
    const target = execSync(command, { encoding: 'utf8' }).trim();
    return target;
  } catch (err) {
    console.error('Error resolving .lnk:', err);
    return null;
  }
});

ipcMain.handle('get-duration', async (event, filePath) => {
  try {
    const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    const duration = execSync(command, { encoding: 'utf8' }).trim();
    return parseFloat(duration);
  } catch (err) {
    console.error('Error getting duration:', err);
    return null;
  }
});

ipcMain.handle('get-audio-peak', async (event, filePath) => {
  try {
    const command = `ffmpeg -i "${filePath}" -af "volumedetect" -vn -sn -dn -f null /dev/null 2>&1`;
    // On Windows, /dev/null is NUL
    const winCommand = `ffmpeg -i "${filePath}" -af "volumedetect" -vn -sn -dn -f null NUL 2>&1`;
    const output = execSync(process.platform === 'win32' ? winCommand : command, { encoding: 'utf8' });
    // Regex matches "max_volume: -10.5 dB" or "max_volume: - 10.5 dB" etc.
    const match = output.match(/max_volume:\s*([\-\d.]+)\s*dB/i);
    if (match) {
      const db = parseFloat(match[1].replace(/\s/g, '')); // Remove internal spaces if any
      // Convert dB to linear amplitude: 10^(db/20)
      return Math.pow(10, db / 20);
    }
    return 1.0; // Default to no-op if logic fails
  } catch (err) {
    console.error('Error getting audio peak:', err);
    return 1.0;
  }
});

ipcMain.handle('read-playlists', async (event, playlistDirPath) => {
  try {
    const playlists = [];
    const items = fs.readdirSync(playlistDirPath, { withFileTypes: true });

    // 1. Scan subdirectories as playlists (legacy behavior)
    for (const item of items) {
      if (item.isDirectory()) {
        const folderPath = path.join(playlistDirPath, item.name);
        const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.url') || f.toLowerCase().endsWith('.lnk'));
        if (files.length > 0) {
          playlists.push({
            name: item.name,
            count: files.length,
            files: files.map(f => path.join(folderPath, f))
          });
        }
      }
    }

    // 2. Scan files in the root Playlists folder (e.g. if they are directly there)
    const rootFiles = items.filter(item => !item.isDirectory() && (item.name.toLowerCase().endsWith('.url') || item.name.toLowerCase().endsWith('.lnk')));
    if (rootFiles.length > 0) {
      playlists.push({
        name: 'Root Playlists',
        count: rootFiles.length,
        files: rootFiles.map(f => path.join(playlistDirPath, f.name))
      });
    }

    return playlists;
  } catch (err) {
    console.error('Error reading playlists:', err);
    return [];
  }
});

// ============================================================
// YouTube Backup IPC Handlers
// ============================================================

ipcMain.handle('write-file', async (event, { filePath, content }) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing file:', err);
    return false;
  }
});

ipcMain.handle('read-dir-recursive', async (event, dirPath) => {
  try {
    const results = [];
    if (!fs.existsSync(dirPath)) return results;

    const walk = (dir) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(fullPath);
        } else {
          results.push(fullPath);
        }
      }
    };
    walk(dirPath);
    return results;
  } catch (err) {
    console.error('Error reading directory recursively:', err);
    return [];
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error deleting file:', err);
    return false;
  }
});

ipcMain.handle('spawn-yt-dlp', async (event, { videoId, outputPath, baseFilename }) => {
  // Helper to find ffmpeg using the working python environment
  let ffmpegDir = '';
  try {
    // Use python to find ffmpeg in the user's path (e.g. WinGet location)
    const stdout = execSync('python -c "import shutil; print(shutil.which(\'ffmpeg\') or \'\')"', { encoding: 'utf8' });
    const ffmpegExe = stdout.trim();
    if (ffmpegExe) {
      ffmpegDir = path.dirname(ffmpegExe);
      console.log('[Main] Found FFmpeg at:', ffmpegDir);
    } else {
      console.warn('[Main] FFmpeg not found via Python lookup.');
    }
  } catch (e) {
    console.error('[Main] Failed to detect FFmpeg:', e);
  }

  return new Promise(async (resolve) => {
    const outputTemplate = path.join(outputPath, `${baseFilename}.%(ext)s`);
    let lastError = '';
    const attemptErrors = [];
    const attempts = getYtDlpCredentialAttempts();

    for (const attempt of attempts) {
      const args = [
        '-f', 'bestaudio',
        '-x', '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', outputTemplate,
        '--no-playlist',
        '--quiet',
        ...getYtDlpSharedArgs()
      ];

      if (ffmpegDir) {
        args.push('--ffmpeg-location', ffmpegDir);
      }

      const result = await runPythonYtDlp([...args, ...attempt.args, '--', videoId]);

      if (result.success) {
        return resolve({ success: true, output: result.stdout });
      }

      lastError = formatYtDlpError(result);
      attemptErrors.push(`[${attempt.type}] ${attempt.label}: ${lastError}`);
      console.warn(`[yt-dlp] Attempt ${attempt.label} (${attempt.type}) failed${result.code !== null ? ` with code ${result.code}` : ''}.`);

      // If the plain no-cookie attempt fails for a non-auth reason, stop immediately.
      if (attempt.type === 'none' && !isCookieRelatedYtDlpError(lastError)) {
        break;
      }

      console.log(`[Main] Retrying yt-dlp with next credential source after: ${attempt.label}`);
    }

    resolve({ success: false, error: attemptErrors.join('\n\n') || lastError });
  });
});

ipcMain.handle('download-thumbnail', async (event, { videoId, outputPath, baseFilename }) => {
  const https = require('https');

  return new Promise((resolve) => {
    const tryDownload = (url, fallbackUrl) => {
      https.get(url, (response) => {
        if (response.statusCode === 200) {
          const filePath = path.join(outputPath, `${baseFilename}.png`);
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          const file = fs.createWriteStream(filePath);
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve({ success: true, path: filePath });
          });
        } else if (fallbackUrl) {
          tryDownload(fallbackUrl, null);
        } else {
          resolve({ success: false, error: `HTTP ${response.statusCode}` });
        }
      }).on('error', (err) => {
        if (fallbackUrl) {
          tryDownload(fallbackUrl, null);
        } else {
          resolve({ success: false, error: err.message });
        }
      });
    };

    const maxResUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const hqUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    tryDownload(maxResUrl, hqUrl);
  });
});

ipcMain.handle('get-video-info', async (event, videoId) => {
  const commonArgs = [...getYtDlpSharedArgs(), '--dump-single-json', '--no-download', '--no-playlist'];

  try {
    const attempts = getYtDlpCredentialAttempts();
    let lastError = '';
    const attemptErrors = [];

    for (const attempt of attempts) {
      const result = await runPythonYtDlp([...commonArgs, ...attempt.args, '--', videoId]);

      if (result.success) {
        const info = JSON.parse(result.stdout);
        return { success: true, title: info.title || `Video_${videoId}` };
      }

      lastError = formatYtDlpError(result);
      attemptErrors.push(`[${attempt.type}] ${attempt.label}: ${lastError}`);

      if (attempt.type === 'none' && !isCookieRelatedYtDlpError(lastError)) {
        break;
      }
    }

    return { success: false, error: attemptErrors.join('\n\n') || lastError };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// New handler for uploading cookies.txt
ipcMain.handle('upload-cookies-txt', async (event) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Select Exported cookies.txt',
      filters: [{ name: 'Text Files', extensions: ['txt'] }],
      properties: ['openFile']
    });

    if (canceled || filePaths.length === 0) return { success: false, error: 'Canceled' };

    const sourcePath = filePaths[0];
    const destPath = path.join(__dirname, 'cookies.txt');

    // Copy the file to the app directory as cookies.txt
    fs.copyFileSync(sourcePath, destPath);
    console.log(`[upload-cookies-txt] Saved cookies to ${destPath}`);

    return { success: true, path: destPath };
  } catch (error) {
    console.error(`[upload-cookies-txt] Error:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('file-exists', async (event, filePath) => {
  return fs.existsSync(filePath);
});

ipcMain.handle('get-app-path', () => {
  return app.getAppPath();
});
