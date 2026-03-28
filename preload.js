const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
    readDir: (dirPath) => ipcRenderer.invoke('read-dir', dirPath),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    loadConfig: () => ipcRenderer.invoke('load-config'),
    saveCSV: (filePath, content) => ipcRenderer.invoke('save-csv', { filePath, content }),
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    readPlaylistData: () => ipcRenderer.invoke('read-playlist-data'),
    getFileUrl: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
    openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
    resolveLnk: (lnkPath) => ipcRenderer.invoke('resolve-lnk', lnkPath),
    readPlaylists: (playlistDirPath) => ipcRenderer.invoke('read-playlists', playlistDirPath),
    getDuration: (filePath) => ipcRenderer.invoke('get-duration', filePath),
    getAudioPeak: (filePath) => ipcRenderer.invoke('get-audio-peak', filePath),
    // YouTube Backup APIs
    writeFile: (filePath, content) => ipcRenderer.invoke('write-file', { filePath, content }),
    readDirRecursive: (dirPath) => ipcRenderer.invoke('read-dir-recursive', dirPath),
    deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
    spawnYtDlp: (videoId, outputPath, baseFilename) => ipcRenderer.invoke('spawn-yt-dlp', { videoId, outputPath, baseFilename }),
    downloadThumbnail: (videoId, outputPath, baseFilename) => ipcRenderer.invoke('download-thumbnail', { videoId, outputPath, baseFilename }),
    getVideoInfo: (videoId) => ipcRenderer.invoke('get-video-info', videoId),
    fileExists: (filePath) => ipcRenderer.invoke('file-exists', filePath),
    getAppPath: () => ipcRenderer.invoke('get-app-path')
});

