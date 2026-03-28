// MP3 Category Player - Web Version
class MP3CategoryPlayer {
    constructor() {
        this.musicDirectory = null;
        this.allSongNames = [];
        this.unclassifiedSongs = [];
        this.songPermutation = [];
        this.currentSongIndex = 0;
        this.currentSong = null;
        this.currentFileURL = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.autoNextEnabled = true;
        this.normalizeEnabled = true;
        this.monoEnabled = false;
        this.classificationColumns = [];
        this.classifiedSongs = {};
        this.config = {};
        this.allPlaylists = [];
        this.selectedPlaylists = [];
        this.selectedSongs = [];
        this.allThumbnails = [];
        this.sidebarChunkSize = 200;
        this.sidebarStart = 0;
        this.sidebarEnd = 0;
        this.songDurations = {}; // Cache for song durations
        this.songPeaks = {};     // Cache for song volume peaks

        // YouTube Backup integration
        this.ytBackup = null;
        this.backupPlaylists = {};
        this.backupPlaylistVars = {};
        this.lastPlaylistClickIndex = undefined;
        this.lastUnavailableClickIndex = undefined;
        this.lastDeletedClickIndex = undefined;
        this.uiListenersBound = false;
        this.mediaKeysBound = false;
        this.audioEventsBound = false;
        this.isInitializing = false;

        this.audioPlayer = document.getElementById('audioPlayer');
        this.timeline = document.getElementById('timeline');
        this.currentTimeDisplay = document.getElementById('currentTime');
        this.durationDisplay = document.getElementById('duration');

        this.initAudioContext();
        this.init();
    }

    async init() {
        if (this.isInitializing) return;
        this.isInitializing = true;

        try {
        await this.loadConfig();
        await this.loadClassificationConfig();
        this.setupEventListeners();
        this.setupMediaKeys();
        this.setupAudioEvents();
        this.updateStats();

        if (this.musicDirectory) {
            this.playlistDirectory = this.musicDirectory.split('/').slice(0, -1).join('/') + '/Playlists';
            this.thumbnailDirectory = this.musicDirectory.split('/').slice(0, -1).join('/') + '/Thumbnails';
            await this.loadPlaylists();
        }

        await this.checkFirstTimeSetup();
        await this.initYTBackup(); // WAIT for sync to complete
        } finally {
            this.isInitializing = false;
        }
    }

    initAudioContext() {
        try {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.source = this.audioCtx.createMediaElementSource(this.audioPlayer);

            // Compressor for normalization
            this.compressor = this.audioCtx.createDynamicsCompressor();
            this.compressor.threshold.setValueAtTime(-24, this.audioCtx.currentTime);
            this.compressor.knee.setValueAtTime(30, this.audioCtx.currentTime);
            this.compressor.ratio.setValueAtTime(12, this.audioCtx.currentTime);
            this.compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
            this.compressor.release.setValueAtTime(0.25, this.audioCtx.currentTime);

            // Node for Mono
            this.monoNode = this.audioCtx.createGain();
            this.monoNode.channelCount = 1;
            this.monoNode.channelCountMode = 'explicit';
            this.monoNode.channelInterpretation = 'speakers';

            this.audioPlayer.crossOrigin = "anonymous";

            // Connect chain
            this.source.connect(this.compressor);
            this.compressor.connect(this.monoNode);
            this.monoNode.connect(this.audioCtx.destination);

            console.log('AudioContext initialized. State:', this.audioCtx.state);
            this.updateAudioSettings();
        } catch (e) {
            console.error('Web Audio API not supported', e);
        }
    }

    updateAudioSettings() {
        if (!this.monoNode) return;

        // Normalization
        // Normalization
        if (this.normalizeEnabled) {
            // Simple linear normalization: Gain = 1 / peak
            // Lookup key handling: try full name, then basename
            let peak = 1.0;
            let lookupKey = this.currentSong ? (this.currentSong.fileName || this.currentSong.name || '') : '';

            if (this.currentSong) {
                // Task 25: Use getConfigKey for consistent lookup (ID-based if YT)
                const filename = this.currentSong.fileName || this.currentSong.name || '';
                lookupKey = this.getConfigKey(filename);

                if (this.songPeaks[lookupKey] !== undefined) {
                    peak = this.songPeaks[lookupKey];
                } else {
                    console.warn(`[Normalization] Peak not found for key: '${lookupKey}'. Available keys: ${Object.keys(this.songPeaks).length}`);
                }
            }

            // Protect against zero or tiny peaks
            if (peak < 0.01) peak = 1.0;

            const gain = 1.0 / peak;

            // Bypass compressor for this simple logic
            this.compressor.threshold.setValueAtTime(0, this.audioCtx.currentTime);
            this.compressor.ratio.setValueAtTime(1, this.audioCtx.currentTime);

            console.log(`[Normalization Debug] Song: ${lookupKey}`);
            console.log(`[Normalization Debug] Peak: ${peak}, Gain Calculated: ${gain}`);

            this.monoNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
            this.monoNode.gain.setValueAtTime(gain, this.audioCtx.currentTime);

            console.log(`[Normalization Debug] Applied Gain: ${this.monoNode.gain.value}`);
        } else {
            // Restore default compressor settings for "Standard" mode
            this.compressor.threshold.setValueAtTime(-24, this.audioCtx.currentTime);
            this.compressor.ratio.setValueAtTime(12, this.audioCtx.currentTime);
            this.compressor.knee.setValueAtTime(30, this.audioCtx.currentTime);
            this.compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
            this.compressor.release.setValueAtTime(0.25, this.audioCtx.currentTime);

            this.monoNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
            this.monoNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);
            console.log(`[Normalization Debug] Normalization DISABLED. Compressor Restored.`);
        }

        // Mono toggle
        if (this.monoEnabled) {
            this.monoNode.channelCount = 1;
        } else {
            this.monoNode.channelCount = 2;
        }
    }

    async loadPlaylists() {
        try {
            // Load JSON map: { plId: [videoId, ...] }
            const rawData = await window.electronAPI.readPlaylistData();
            if (!rawData) {
                console.log('No playlist_data.json found.');
                this.allPlaylists = [];
                return;
            }

            // Build map of VideoID -> Song Name (from valid files)
            const idToSong = {};

            this.allSongNames.forEach(song => {
                if (this.isYouTubeSong(song.name)) {
                    const vidId = this.getSongIdentifier(song.name);
                    if (vidId) {
                        idToSong[vidId] = song.name;
                    }
                }
            });

            const playlists = [];
            for (const plId in rawData) {
                const plData = rawData[plId];
                let vidIds = [];
                let plName = plId;

                // Support both legacy array [id, id] and new object { title, video_ids }
                if (Array.isArray(plData)) {
                    vidIds = plData;
                } else if (plData && plData.video_ids) {
                    vidIds = plData.video_ids;
                    plName = plData.title || plId;
                }

                if (!Array.isArray(vidIds)) continue;

                const songs = vidIds.map(vid => idToSong[vid]).filter(Boolean);

                if (songs.length > 0) {
                    playlists.push({
                        id: plId, // Task 10: Store ID for robust identification
                        name: plName,
                        songs: songs,
                        count: songs.length
                    });
                }
            }

            this.allPlaylists = playlists;
            console.log(`Loaded ${playlists.length} playlists from JSON.`);

        } catch (err) {
            console.error('Failed to load playlists:', err);
            this.allPlaylists = [];
        }
    }

    async loadThumbnails() {
        if (!this.thumbnailDirectory) return;
        try {
            const files = await window.electronAPI.readDir(this.thumbnailDirectory);
            this.allThumbnails = files.filter(f => f.match(/\.(png|jpg|jpeg|webp)$/i));
            console.log('Loaded thumbnails from', this.thumbnailDirectory, ':', this.allThumbnails.length);
        } catch (err) {
            console.error('Failed to load thumbnails:', err);
            this.allThumbnails = [];
        }
    }

    async loadConfig() {
        const config = await window.electronAPI.loadConfig();
        if (config) {
            this.config = config;
            this.songDurations = config.songDurations || {};
            this.songPeaks = config.songPeaks || {};
            this.applyConfig(config);
        } else {
            this.config = {};
        }
    }

    async saveConfig() {
        this.config.songDurations = this.songDurations;
        this.config.songPeaks = this.songPeaks;
        await window.electronAPI.saveConfig(this.config);
    }

    getConfigKey(filename) {
        // Task 25: Use ID as key if it matches "-(ID).ext" format at the end of the filename
        // This prevents re-analysis when filenames are sanitized/changed but ID is constant
        const match = filename.match(/-\(([\w-]{11})\)\.(mp3|wav|flac|m4a|ogg|webm|aac|opus)$/i);
        if (match) {
            return match[1]; // Return ID (11 chars)
        }
        return filename; // Return full filename if not a YouTube file format
    }

    async runStartupScan() {
        if (!this.allSongNames.length) return;

        // Check against cached durations and peaks using getConfigKey
        const missingDuration = [];
        const missingPeak = [];

        for (const s of this.allSongNames) {
            const key = this.getConfigKey(s.name);
            if (this.songDurations[key] === undefined) missingDuration.push(s);
            if (this.songPeaks[key] === undefined) missingPeak.push(s);
        }

        // Combine unique songs needing scan
        const scanSet = new Set([...missingDuration, ...missingPeak]);
        const scanList = Array.from(scanSet);

        if (scanList.length === 0) return;

        const modal = document.getElementById('startupScanModal');
        const progBar = document.getElementById('startupProgressBar');
        const progText = document.getElementById('startupProgressText');
        const progStatus = document.getElementById('startupStatus');

        if (modal) modal.style.display = 'block';

        for (let i = 0; i < scanList.length; i++) {
            const song = scanList[i];
            const filePath = this.getFileForSong(song.name);
            const key = this.getConfigKey(song.name);

            if (progBar && progText) {
                const pct = Math.round((i / scanList.length) * 100);
                progBar.style.width = `${pct}%`;
                progText.textContent = `${pct}%`;
                if (progStatus) progStatus.textContent = `Analyzing: ${song.name}`;
            }

            if (filePath) {
                // Check individually again just to be sure we don't overwrite if present
                if (this.songDurations[key] === undefined) {
                    const dur = await window.electronAPI.getDuration(filePath);
                    if (dur) this.songDurations[key] = dur;
                }
                if (this.songPeaks[key] === undefined) {
                    const peak = await window.electronAPI.getAudioPeak(filePath);
                    // peak is now linear amplitude (e.g. 0.8), or 1.0 on error
                    if (peak !== null) this.songPeaks[key] = peak;
                }
            }
        }

        if (modal) modal.style.display = 'none';
        await this.saveConfig();
    }

    async checkFirstTimeSetup() {
        if (this.config.musicDirectory) {
            // Auto-load if we have a directory saved
            await this.loadMusicFromDirectory(this.config.musicDirectory);

            if (this.config.lastCSVFile) {
                await this.importCSVFromPath(this.config.lastCSVFile);
            }

            // Run startup scan AFTER loading music
            await this.runStartupScan();

            if (this.config.lastPermutationFile) {
                try {
                    console.log('Restoring last permutation config:', this.config.lastPermutationFile);
                    await this.importConfigFromPath(this.config.lastPermutationFile);
                    // Automatically create permutation from the loaded config
                    setTimeout(() => this.createPermutation(), 500);
                } catch (e) {
                    console.error('Failed to restore last permutation:', e);
                }
            }

            this.closeSetupModal();
        } else {
            this.showSetupModal();
        }
    }

    showSetupModal() {
        const modal = document.getElementById('setupModal');
        if (modal) {
            modal.style.display = 'block';
        }
    }

    closeSetupModal() {
        const modal = document.getElementById('setupModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    async handleSetupComplete() {
        if (this.allSongNames.length === 0) {
            alert('Please select your music directory first.');
            return;
        }

        await this.saveConfig();
        this.closeSetupModal();

        if (this.pendingPermutationCriteria) {
            this.applyPermutationFilter(this.pendingPermutationCriteria);
            this.pendingPermutationCriteria = null;
        } else {
            this.playCurrentSong();
        }
    }

    handleStartOnly() {
        if (this.allSongNames.length === 0) {
            alert('Please click "Browse" and select your music folder.');
            return;
        }

        this.closeSetupModal();

        if (this.pendingPermutationCriteria) {
            this.applyPermutationFilter(this.pendingPermutationCriteria);
            this.pendingPermutationCriteria = null;
        } else {
            this.playCurrentSong();
        }
    }

    applyConfig(config) {
        this.config = config;
        if (config.musicDirectory) {
            this.musicDirectory = config.musicDirectory;
            const setupDirPath = document.getElementById('setupDirPath');
            if (setupDirPath) setupDirPath.value = config.musicDirectory;
        }
        if (config.lastCSVFile) {
            const setupCSVPath = document.getElementById('setupCSVPath');
            if (setupCSVPath) setupCSVPath.value = config.lastCSVFile;
        }
        if (config.lastPermutationFile) {
            const setupPermPath = document.getElementById('setupPermPath');
            if (setupPermPath) setupPermPath.value = config.lastPermutationFile;
        }
    }

    async loadClassificationConfig() {
        const configPath = 'classification_config.json'; // Simplified for now, or use absolute path
        const configStr = await window.electronAPI.readFile(configPath);
        if (configStr) {
            this.classificationColumns = JSON.parse(configStr);
        } else {
            this.classificationColumns = [
                {
                    name: 'Category',
                    values: ['PowerMetal', 'PopPunk, PopRock', 'Rock', 'Pop, EDM,R&B', 'Country',
                        'Acoustic', 'PyrateMetal', 'FolkMetal, FolkRock, Folk', 'SymphonicMetal',
                        'TrashMetal', 'Instrumental', 'Epic', 'OtherMetal', 'Jazz', 'Funk',
                        'Multiple Songs - Different']
                },
                {
                    name: 'Tier',
                    values: ['S++', 'S+', 'S', 'A', 'B', 'C', 'D', 'E', 'F']
                },
                {
                    name: 'Happyness',
                    values: ['+2', '+1', ' 0', '-1', '-2']
                },
                {
                    name: 'Version',
                    values: ['Studio - Good', 'Studio - Bad', 'Live - Good', 'Live - Bad', 'Live - Multiple Songs']
                }
            ];
            await window.electronAPI.saveCSV(configPath, JSON.stringify(this.classificationColumns, null, 2));
        }
        this.renderClassifications();
    }

    setupEventListeners() {
        if (this.uiListenersBound) return;
        this.uiListenersBound = true;

        document.getElementById('browseBtn').addEventListener('click', async () => {
            const dir = await window.electronAPI.selectDirectory();
            if (dir) {
                await this.loadMusicFromDirectory(dir);
            }
        });

        document.getElementById('importCSVBtn').addEventListener('click', () => {
            this.importCSV();
        });

        document.getElementById('exportCSVBtn').addEventListener('click', () => {
            this.exportCSV();
        });

        document.getElementById('prevBtn')?.addEventListener('click', () => this.previousSong());
        document.getElementById('playPauseBtn')?.addEventListener('click', () => this.togglePlayPause());
        document.getElementById('nextBtn')?.addEventListener('click', () => this.nextSong());
        document.getElementById('openPlayerBtn')?.addEventListener('click', () => this.openInPlayer());
        document.getElementById('openYTBtn')?.addEventListener('click', () => this.openInYouTube());

        document.getElementById('autoNextCheck')?.addEventListener('change', (e) => {
            this.autoNextEnabled = e.target.checked;
        });

        document.getElementById('normalizeCheck')?.addEventListener('change', (e) => {
            this.normalizeEnabled = e.target.checked;
            this.updateAudioSettings();
        });

        document.getElementById('monoCheck')?.addEventListener('change', (e) => {
            this.monoEnabled = e.target.checked;
            this.updateAudioSettings();
        });

        document.getElementById('saveBtn')?.addEventListener('click', () => this.saveClassification());

        document.getElementById('createPermutationBtn')?.addEventListener('click', () => {
            this.openPermutationModal();
        });

        document.querySelector('.close').addEventListener('click', () => {
            this.closePermutationModal();
        });

        document.querySelector('.close-playlists')?.addEventListener('click', () => {
            this.closePlaylistModal();
        });

        document.getElementById('openPlaylistSelectorBtn')?.addEventListener('click', () => {
            this.openPlaylistModal();
        });

        document.getElementById('confirmPlaylistsBtn')?.addEventListener('click', () => {
            this.closePlaylistModal();
        });

        document.getElementById('selectAllPlaylists')?.addEventListener('change', (e) => {
            this.selectAllPlaylists(e.target.checked);
        });

        document.getElementById('playlistSortSelect')?.addEventListener('change', () => {
            this.renderPlaylistList();
        });

        document.getElementById('playlistSearch')?.addEventListener('input', () => {
            this.renderPlaylistList();
        });

        // Song modal event listeners
        document.querySelector('.close-songs')?.addEventListener('click', () => {
            this.closeSongModal();
        });

        document.getElementById('openSongSelectorBtn')?.addEventListener('click', () => {
            this.openSongModal();
        });

        document.getElementById('confirmSongsBtn')?.addEventListener('click', () => {
            this.closeSongModal();
        });

        document.getElementById('selectAllSongs')?.addEventListener('change', (e) => {
            this.selectAllSongs(e.target.checked);
        });

        document.getElementById('songSortSelect')?.addEventListener('change', () => {
            this.renderSongList();
        });

        document.getElementById('songSearch')?.addEventListener('input', () => {
            this.renderSongList();
        });

        document.getElementById('createPermutationSubmitBtn')?.addEventListener('click', () => {
            this.createPermutation();
        });

        document.getElementById('importConfigBtn')?.addEventListener('click', () => {
            this.importConfig();
        });

        document.getElementById('exportConfigBtn')?.addEventListener('click', () => {
            this.exportConfig();
        });

        // Setup modal event listeners
        document.getElementById('setupLoadDefaultConfigBtn')?.addEventListener('click', () => {
            this.init(); // Re-init to load config
        });

        document.getElementById('setupLoadConfigBtn')?.addEventListener('click', () => {
            this.importConfig();
        });

        document.getElementById('setupBrowseBtn')?.addEventListener('click', async () => {
            const dir = await window.electronAPI.selectDirectory();
            if (dir) {
                await this.loadMusicFromDirectory(dir, true);
            }
        });

        document.getElementById('setupCSVBtn')?.addEventListener('click', () => {
            this.importCSV(true);
        });

        document.getElementById('setupUpdateCSVBtn')?.addEventListener('click', () => {
            this.importCSV(true);
        });

        document.getElementById('setupPermBtn')?.addEventListener('click', () => {
            this.importConfig();
        });

        document.getElementById('setupStartBtn')?.addEventListener('click', () => {
            this.handleStartOnly();
        });

        document.getElementById('setupCompleteBtn')?.addEventListener('click', () => {
            this.handleSetupComplete();
        });

        // Timeline seeking
        this.timeline.addEventListener('input', () => {
            if (this.audioPlayer.duration) {
                const time = (this.timeline.value / 100) * this.audioPlayer.duration;
                this.audioPlayer.currentTime = time;
            }
        });

        // Enter key for saving classification
        window.addEventListener('keydown', (e) => {
            // Allow shortcuts if focus is on range, checkbox, or radio (but not text/textarea)
            const isTextInput = (e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.target.type === 'number')) ||
                e.target.tagName === 'TEXTAREA';
            if (isTextInput) return;

            if (e.key === 'Enter') {
                this.saveClassification();
            } else if (e.key === ' ') {
                e.preventDefault();
                this.togglePlayPause();
            } else if (e.key === 'ArrowRight') {
                this.audioPlayer.currentTime += 5;
            } else if (e.key === 'ArrowLeft') {
                this.audioPlayer.currentTime -= 5;
            }
        });

        // Sidebar Enhancements
        document.getElementById('centerSongBtn')?.addEventListener('click', () => {
            this.centerCurrentSong();
        });

        // Task 21: Moved up for reliability
        document.getElementById('manageUnavailableBtn')?.addEventListener('click', () => {
            console.log('[App] Unavailable button clicked');
            this.openUnavailableModal();
        });

        document.getElementById('manageDeletedBtn')?.addEventListener('click', () => {
            console.log('[App] Deleted button clicked');
            this.openDeletedModal();
        });

        const sidebar = document.getElementById('thumbnailSidebar');
        sidebar?.addEventListener('scroll', () => {
            this.updateSidebarButtonUI();
            // Task 2: Load more thumbnails when scrolling near edges
            if (sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 100) {
                this.loadMoreThumbnails();
            }
            if (sidebar.scrollTop <= 100) {
                this.loadPrevThumbnails();
            }
        });

        // Blur timeline and other inputs after interaction to keep focus on body
        const blurInputs = () => { if (document.activeElement) document.activeElement.blur(); };
        this.timeline.addEventListener('change', blurInputs);
        document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(el => {
            el.addEventListener('change', blurInputs);
        });

        // =====================================================
        // YouTube Backup Event Listeners
        // =====================================================
        document.getElementById('downloadMusicBtn')?.addEventListener('click', () => {
            this.openBackupModal();
        });

        document.querySelector('.close-backup')?.addEventListener('click', () => {
            this.closeBackupModal();
        });

        document.getElementById('browseTakeoutBtn')?.addEventListener('click', async () => {
            const dir = await window.electronAPI.selectDirectory();
            if (dir) {
                await this.loadBackupPlaylists(dir);
            }
        });

        document.getElementById('selectAllBackupPlaylists')?.addEventListener('change', (e) => {
            this.selectAllBackupPlaylists(e.target.checked);
        });

        document.getElementById('backupPlaylistSearch')?.addEventListener('input', () => {
            this.renderBackupPlaylistList();
        });

        document.getElementById('backupPlaylistSortSelect')?.addEventListener('change', (e) => {
            if (this.ytBackup) {
                this.ytBackup.settings.playlist_sort_type = e.target.value;
                this.ytBackup.saveSettings();
            }
            this.renderBackupPlaylistList();
        });

        document.getElementById('startDownloadBtn')?.addEventListener('click', () => {
            this.startBackupDownload();
        });

        document.getElementById('generateLinksOnlyBtn')?.addEventListener('click', () => {
            this.generatePlaylistDataOnly();
        });

        // Backup Modal Event Listeners
        document.querySelector('.close-backup')?.addEventListener('click', () => {
            this.closeBackupModal();
        });

        document.querySelector('.close-unavailable')?.addEventListener('click', () => {
            this.closeUnavailableModal();
        });

        document.querySelector('.close-deleted')?.addEventListener('click', () => {
            this.closeDeletedModal();
        });

        document.getElementById('selectAllUnavailable')?.addEventListener('change', (e) => {
            const checkboxes = document.querySelectorAll('#unavailableList input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = e.target.checked);
        });

        document.getElementById('unavailableSortSelect')?.addEventListener('change', (e) => {
            if (this.ytBackup) {
                this.ytBackup.settings.deleted_sort_type = e.target.value;
                this.ytBackup.saveSettings();
            }
            this.renderUnavailableList();
        });

        document.getElementById('retryUnavailableBtn')?.addEventListener('click', () => {
            this.retrySelectedUnavailable();
        });

        document.getElementById('removeUnavailableBtn')?.addEventListener('click', () => {
            this.ignoreSelectedUnavailable();
        });

        // Backup Modal Immediate Auto-Save
        document.getElementById('backupPlaylistSortSelect')?.addEventListener('change', async (e) => {
            const ytBackup = await this.initYTBackup();
            ytBackup.settings.playlist_sort_type = e.target.value;
            await ytBackup.saveSettings();
            this.renderBackupPlaylistList();
        });

        document.getElementById('downloadDelay')?.addEventListener('change', async (e) => {
            const ytBackup = await this.initYTBackup();
            ytBackup.settings.delay_between_downloads = e.target.value;
            await ytBackup.saveSettings();
        });

        // Cookie Modal Event Listeners
        document.querySelector('.close-cookie')?.addEventListener('click', () => {
            document.getElementById('cookieModal').style.display = 'none';
        });

        document.getElementById('uploadCookiesBtn')?.addEventListener('click', async () => {
            const filters = [{ name: 'Text Files', extensions: ['txt'] }];
            const filePathResult = await window.electronAPI.selectFile(filters);
            if (filePathResult) {
                const statusSpan = document.getElementById('cookieUploadStatus');
                try {
                    const content = await window.electronAPI.readFile(filePathResult);
                    const appPath = await window.electronAPI.getAppPath();
                    const destPath = `${appPath}\\cookies.txt`;
                    await window.electronAPI.writeFile(destPath, content);
                    if (statusSpan) {
                        statusSpan.textContent = '✅ cookies.txt uploaded and ready!';
                        statusSpan.style.color = '#4CAF50';
                    }
                    window.dispatchEvent(new Event('cookies-uploaded'));

                    // Resume if it was paused
                    if (this.ytBackup && this.ytBackup.pauseRequested) {
                        this.ytBackup.resume();
                        const prBtn = document.getElementById('pauseResumeBtn');
                        if (prBtn) prBtn.textContent = '⏸ Pause';
                        document.getElementById('backupStatus').textContent = 'Download resumed';
                    }
                } catch (err) {
                    console.error('Failed to upload cookies:', err);
                    if (statusSpan) {
                        statusSpan.textContent = '❌ Upload failed';
                        statusSpan.style.color = '#f44336';
                    }
                }
            }
        });

        document.getElementById('maxDownloads')?.addEventListener('change', async (e) => {
            const ytBackup = await this.initYTBackup();
            ytBackup.settings.max_downloads = e.target.value;
            await ytBackup.saveSettings();
        });

        document.getElementById('skipDeletedBtn')?.addEventListener('click', () => {
            this.closeDeletedModal();
        });

        document.getElementById('selectAllDeleted')?.addEventListener('change', (e) => {
            const checkboxes = document.querySelectorAll('#deletedList input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = e.target.checked);
        });

        document.getElementById('deletedSortSelect')?.addEventListener('change', () => {
            this.renderDeletedList();
        });

        document.getElementById('restoreDeletedBtn')?.addEventListener('click', () => {
            this.restoreSelectedDeleted();
        });
    }

    async loadMusicFromDirectory(dirPath, fromSetup = false) {
        // Normalize path for Windows/Unix compatibility
        const normalizedPath = dirPath.replace(/\\/g, '/');
        this.musicDirectory = normalizedPath;
        const files = await window.electronAPI.readDir(normalizedPath);

        const audioExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.webm', '.ogg', '.aac', '.opus'];
        this.allSongNames = files
            .filter(f => {
                const lower = f.toLowerCase();
                return audioExtensions.some(ext => lower.endsWith(ext));
            })
            .map(f => ({
                name: f,
                path: `${normalizedPath}/${f}`
            }));

        if (this.allSongNames.length === 0) {
            alert('No MP3 files found in the selected directory.');
            return;
        }

        const displayText = `${normalizedPath} (${this.allSongNames.length} songs)`;
        const dirInput = document.getElementById('dirPath');
        if (dirInput) dirInput.value = displayText;

        const setupDirInput = document.getElementById('setupDirPath');
        if (fromSetup && setupDirInput) {
            setupDirInput.value = displayText;
        }

        this.config.musicDirectory = normalizedPath;

        // Sibling folders: .../Parent/Audio -> .../Parent/Playlists
        const pathParts = normalizedPath.split('/');
        const parentPath = pathParts.slice(0, -1).join('/');

        this.playlistDirectory = parentPath + '/Playlists';
        this.thumbnailDirectory = parentPath + '/Thumbnails';

        console.log('Playlist Dir:', this.playlistDirectory);
        console.log('Thumbnail Dir:', this.thumbnailDirectory);

        await this.loadPlaylists();
        await this.loadThumbnails();

        if (!fromSetup) {
            await this.runStartupScan(); // Wait for scan
            this.scanMusicFiles(); // Re-scan classification with any new info if needed

            // Re-apply config to respect saved permutation
            if (this.config) {
                this.applyConfig(this.config);
            } else {
                this.createSongPermutation();
            }
            this.updateStats();

            await this.saveConfig();
            this.playCurrentSong();
        } else {
            this.scanMusicFiles();
            this.createSongPermutation();
            this.updateStats();
        }
    }

    setupMediaKeys() {
        if (this.mediaKeysBound) return;
        this.mediaKeysBound = true;

        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => this.togglePlayPause());
            navigator.mediaSession.setActionHandler('pause', () => this.togglePlayPause());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.previousSong());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.nextSong());
            navigator.mediaSession.setActionHandler('seekto', (details) => {
                if (details.seekTime !== undefined) {
                    this.audioPlayer.currentTime = details.seekTime;
                }
            });
        }
    }

    setupAudioEvents() {
        if (this.audioEventsBound) return;
        this.audioEventsBound = true;

        this.audioPlayer.addEventListener('timeupdate', () => this.updateTimeline());
        this.audioPlayer.addEventListener('loadedmetadata', () => this.updateDuration());
        this.audioPlayer.addEventListener('ended', () => this.songFinished());
        this.audioPlayer.addEventListener('play', () => {
            this.isPlaying = true;
            this.isPaused = false;
            this.updateMediaSessionState();
        });
        this.audioPlayer.addEventListener('pause', () => {
            this.isPaused = true;
            this.updateMediaSessionState();
        });
    }

    updateTimeline() {
        if (this.audioPlayer.duration) {
            const percent = (this.audioPlayer.currentTime / this.audioPlayer.duration) * 100;
            this.timeline.value = percent;
            this.currentTimeDisplay.textContent = this.formatTime(this.audioPlayer.currentTime);
        }
    }

    updateDuration() {
        if (this.audioPlayer.duration) {
            this.durationDisplay.textContent = this.formatTime(this.audioPlayer.duration);
        }
    }

    formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    updateMediaSessionState() {
        if ('mediaSession' in navigator && this.currentSong) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: this.currentSong.name,
                artist: 'Video ID: ' + this.currentSong.videoId,
                album: 'Music Downloader + Player + Clasifyer'
            });
            navigator.mediaSession.playbackState = this.isPlaying && !this.isPaused ? 'playing' : 'paused';
        }
    }

    parseCSVLine(line) {
        const values = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                values.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current);
        return values;
    }

    async exportCSV() {
        const result = await window.electronAPI.showSaveDialog({
            title: 'Export Classifications CSV (Save As)',
            defaultPath: this.config.lastCSVFile || (this.musicDirectory ? `${this.musicDirectory}/song_classifications.csv` : 'song_classifications.csv'),
            filters: [{ name: 'CSV Files', extensions: ['csv'] }]
        });

        if (!result.canceled && result.filePath) {
            const headers = ['video_id', ...this.classificationColumns.map(col => col.name)];
            let csvContent = headers.join(',') + '\n';

            for (const [videoId, classifications] of Object.entries(this.classifiedSongs)) {
                const row = [videoId];
                for (const column of this.classificationColumns) {
                    const value = classifications[column.name] || '';
                    const escapedValue = `"${value.toString().replace(/"/g, '""')}"`;
                    row.push(escapedValue);
                }
                csvContent += row.join(',') + '\n';
            }

            const success = await window.electronAPI.saveCSV(result.filePath, csvContent);
            if (success) {
                this.config.lastCSVFile = result.filePath;
                await this.saveConfig();
                alert('Classifications exported successfully!');
            }
        }
    }

    async importCSV(fromSetup = false) {
        const filePath = await window.electronAPI.selectFile([
            { name: 'CSV Files', extensions: ['csv'] },
            { name: 'All Files', extensions: ['*'] }
        ]);

        if (filePath) {
            await this.importCSVFromPath(filePath, fromSetup);
        }
    }

    async importCSVFromPath(filePath, fromSetup = false) {
        try {
            const text = await window.electronAPI.readFile(filePath);
            if (!text) return;

            const lines = text.split('\n').filter(line => line.trim());
            if (lines.length === 0) return;

            const headers = this.parseCSVLine(lines[0]);
            const videoIdIndex = headers.indexOf('video_id');
            if (videoIdIndex === -1) {
                alert('CSV must have a "video_id" column');
                return;
            }

            this.classifiedSongs = {};
            for (let i = 1; i < lines.length; i++) {
                const values = this.parseCSVLine(lines[i]);
                if (values.length < videoIdIndex + 1) continue;

                const rawId = values[videoIdIndex];
                const idMatch = rawId.match(/\((.{11})\)/) || [null, rawId];
                const videoId = idMatch[1];

                const classifications = {};
                for (let j = 0; j < headers.length; j++) {
                    if (j !== videoIdIndex && values[j]) {
                        classifications[headers[j]] = values[j];
                    }
                }
                this.classifiedSongs[videoId] = classifications;
            }

            this.config.lastCSVFile = filePath;
            if (!fromSetup) {
                await this.saveConfig();
                this.scanMusicFiles();
                this.updateStats();
                // alert(`Imported ${Object.keys(this.classifiedSongs).length} classifications.`);
            }
        } catch (err) {
            alert('Error importing CSV: ' + err.message);
        }
    }

    scanMusicFiles() {
        this.unclassifiedSongs = [];

        for (const songData of this.allSongNames) {
            const identifier = this.getSongIdentifier(songData.name);
            if (identifier) {
                if (!this.classifiedSongs[identifier]) {
                    this.unclassifiedSongs.push(songData.name);
                } else {
                    let missing = false;
                    for (const column of this.classificationColumns) {
                        if (!this.classifiedSongs[identifier][column.name]) {
                            missing = true;
                            break;
                        }
                    }
                    if (missing) this.unclassifiedSongs.push(songData.name);
                }
            } else {
                console.warn('Could not determine identifier for song:', songData.name);
            }
        }
    }

    createSongPermutation() {
        // Only include songs that match the pattern to avoid sidebar/index issues
        const pattern = this.getSongMatchPattern();
        const matched = [];
        const unmatched = [];

        for (const s of this.allSongNames) {
            if (s.name.match(pattern)) {
                matched.push(s.name);
            } else {
                unmatched.push(s.name);
            }
        }

        if (unmatched.length > 0) {
            console.warn(`[Song Pattern] ${unmatched.length} songs don't match the pattern and will be excluded:`);
            unmatched.forEach(name => console.warn(`  - ${name}`));
        }

        this.songPermutation = matched;
        this.shuffleArray(this.songPermutation);
        this.currentSongIndex = 0;
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array; // Return it for chaining
    }

    getFileForSong(songName) {
        const songData = this.allSongNames.find(s => s.name === songName);
        return songData ? songData.path : null;
    }

    async playCurrentSong() {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        if (this.songPermutation.length === 0) {
            if (!this.musicDirectory) {
                alert('Please select a music directory first.');
            } else {
                // alert('All songs have been classified!');
                console.log('All songs have been classified!');
            }
            return;
        }

        if (this.isPlaying) {
            this.stopSong();
        }

        if (this.currentSongIndex >= 0 && this.currentSongIndex < this.songPermutation.length) {
            const songName = this.songPermutation[this.currentSongIndex];
            this.playSong(songName);
        }
    }

    async playSong(songName) {
        const pattern = this.getSongMatchPattern();
        const match = songName.match(pattern);

        let name = songName;
        let videoId = null;
        const isYouTube = this.isYouTubeSong(songName);
        const identifier = this.getSongIdentifier(songName);

        if (match) {
            name = match[1];
            videoId = match[2];
        } else {
            // For non-YouTube songs, use filename without extension as display name
            name = songName.replace(/\.[^.]+$/, '');
            console.log('Playing non-YouTube song:', songName);
        }

        const filePath = this.getFileForSong(songName);
        if (!filePath) {
            alert('Could not find file: ' + songName);
            return;
        }

        // Task 9: Store identifier for both YT and non-YT songs
        this.currentSong = { name: name, videoId: identifier, fileName: songName, path: filePath, isYouTube: isYouTube };

        const currentPos = this.currentSongIndex + 1;
        const totalSongs = this.songPermutation.length;
        const songInfoLeftEl = document.getElementById('songInfoLeft');

        if (songInfoLeftEl) {
            // Truncate name to 50 chars
            const truncatedName = name.length > 50 ? name.substring(0, 50) + '...' : name;
            // Format: 1/1547 Title... [VideoID] or just Title for non-YT
            if (isYouTube && videoId) {
                songInfoLeftEl.innerHTML = `${currentPos}/<b>${totalSongs}</b> &nbsp; ${truncatedName} &nbsp; <span style="color: #888; font-size: 0.9em;">[${videoId}]</span>`;
            } else {
                songInfoLeftEl.innerHTML = `${currentPos}/<b>${totalSongs}</b> &nbsp; ${truncatedName}`;
            }
        }

        // Task 9: Show/hide YouTube button based on song type
        const ytBtn = document.getElementById('openYTBtn');
        if (ytBtn) {
            ytBtn.style.display = isYouTube ? '' : 'none';
        }

        this.clearClassificationSelections();
        if (identifier && this.classifiedSongs[identifier]) {
            this.loadClassificationSelections(identifier);
        }

        const fileUrl = await window.electronAPI.getFileUrl(filePath);
        this.audioPlayer.src = fileUrl;

        // Ensure audio settings (normalization) are applied for this new song
        // Must happen after this.currentSong is set so we can look up the peak
        this.updateAudioSettings();

        this.audioPlayer.play().catch(err => {
            console.error('Error playing song:', err);
        });

        this.isPlaying = true;
        this.isPaused = false;
        this.updateMediaSessionState();

        // Smarter sidebar update: only re-render if needed
        const activeItem = document.getElementById(`thumb-${this.currentSongIndex}`);
        if (!activeItem) {
            this.renderThumbnailSidebar();
        } else {
            // Just update active class
            document.querySelectorAll('.thumbnail-item.active').forEach(el => el.classList.remove('active'));
            activeItem.classList.add('active');
            this.centerCurrentSong();
        }
    }

    async renderThumbnailSidebar() {
        const sidebar = document.getElementById('thumbnailSidebar');
        if (!sidebar) return;

        // Clear and render new window
        sidebar.innerHTML = '';
        const range = Math.floor(this.sidebarChunkSize / 2);
        this.sidebarStart = Math.max(0, this.currentSongIndex - range);
        this.sidebarEnd = Math.min(this.songPermutation.length - 1, this.currentSongIndex + range);

        for (let i = this.sidebarStart; i <= this.sidebarEnd; i++) {
            await this.renderSidebarItem(i, sidebar);
        }

        // Auto-center after rendering
        this.centerCurrentSong();
    }

    async renderSidebarItem(index, container, prepend = false) {
        const songName = this.songPermutation[index];
        const isYouTube = this.isYouTubeSong(songName);
        const identifier = this.getSongIdentifier(songName);
        const match = songName.match(this.getSongMatchPattern());

        let name = songName.replace(/\.[^.]+$/, ''); // Default: filename without extension
        if (match) {
            name = match[1];
        }

        const classifications = this.classifiedSongs[identifier] || {};
        const item = document.createElement('div');
        item.className = 'thumbnail-item';
        item.id = `thumb-${index}`;
        if (index === this.currentSongIndex) item.className += ' active';

        const metadata = `Name: ${name}\n` +
            `Category: ${classifications['Category'] || 'Unclassified'}\n` +
            `Tier: ${classifications['Tier'] || '-'}\n` +
            `Happiness: ${classifications['Happyness'] || '-'}\n` +
            `Version: ${classifications['Version'] || '-'}`;

        item.setAttribute('data-tooltip', metadata);
        item.title = metadata; // Native tooltip fallback

        const img = document.createElement('img');
        let thumbFile;
        if (isYouTube) {
            // For YouTube songs, look for thumbnail with video ID
            thumbFile = this.allThumbnails.find(f => f.includes(`(${identifier})`)) || `${identifier}.png`;
        } else {
            // Task 9: For non-YouTube songs, match thumbnail by filename (without extension)
            thumbFile = this.allThumbnails.find(f => f.replace(/\.[^.]+$/, '') === identifier) || `${identifier}.png`;
        }
        const thumbPath = `${this.thumbnailDirectory}/${thumbFile}`;
        img.src = await window.electronAPI.getFileUrl(thumbPath);
        img.onerror = () => {
            img.onerror = null;
            img.src = 'placeholder.png';
        };

        item.appendChild(img);
        item.onclick = () => {
            this.currentSongIndex = index;
            this.playCurrentSong();
        };

        if (prepend) {
            container.insertBefore(item, container.firstChild);
        } else {
            container.appendChild(item);
        }
    }

    async loadMoreThumbnails() {
        const sidebar = document.getElementById('thumbnailSidebar');
        if (!sidebar) return;

        const start = this.sidebarEnd + 1;
        const end = Math.min(this.songPermutation.length - 1, start + this.sidebarChunkSize);

        if (start > end) return;

        this.sidebarEnd = end;

        for (let i = start; i <= end; i++) {
            await this.renderSidebarItem(i, sidebar);
        }
    }

    async loadPrevThumbnails() {
        const sidebar = document.getElementById('thumbnailSidebar');
        if (!sidebar) return;

        const end = this.sidebarStart - 1;
        const start = Math.max(0, end - this.sidebarChunkSize);

        if (end < 0) return;

        const oldScrollHeight = sidebar.scrollHeight;
        const oldScrollTop = sidebar.scrollTop;

        this.sidebarStart = start;

        // Render at the beginning
        for (let i = end; i >= start; i--) {
            await this.renderSidebarItem(i, sidebar, true);
        }

        // Maintain scroll position after adding items at top
        const newScrollHeight = sidebar.scrollHeight;
        sidebar.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
    }

    centerCurrentSong() {
        const activeItem = document.getElementById(`thumb-${this.currentSongIndex}`);
        if (activeItem) {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            // If the item is not yet rendered, we should ideally render it
            // but for now let's just render the sidebar around it if possible
            this.renderThumbnailSidebar().then(() => {
                const retryItem = document.getElementById(`thumb-${this.currentSongIndex}`);
                if (retryItem) retryItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        }
        this.updateSidebarButtonUI();
    }

    updateSidebarButtonUI() {
        const sidebar = document.getElementById('thumbnailSidebar');
        const btn = document.getElementById('centerSongBtn');
        const activeItem = document.getElementById(`thumb-${this.currentSongIndex}`);

        if (!sidebar || !btn) return;

        if (!activeItem) {
            // If current song isn't rendered, we show the target/default
            btn.textContent = '🎯';
            return;
        }

        const sidebarRect = sidebar.getBoundingClientRect();
        const itemRect = activeItem.getBoundingClientRect();

        // Check if item is above or below current view
        if (itemRect.bottom < sidebarRect.top) {
            btn.textContent = '↑';
        } else if (itemRect.top > sidebarRect.bottom) {
            btn.textContent = '↓';
        } else {
            btn.textContent = '🎯';
        }
    }

    getSongMatchPattern() {
        // Strict pattern to match "Title-(ID).ext" at the end of the string
        // Uses greedy matching (.*) to handle titles that contain dashes
        return /^(.*)-\(([\w-]{11})\)\.(mp3|wav|flac|m4a|webm|ogg|aac|opus)$/i;
    }

    // Task 9: Check if a song has a YouTube ID in its filename
    isYouTubeSong(songName) {
        return /\([\w-]{11}\)\.(mp3|wav|flac|m4a|webm|ogg|aac|opus)$/i.test(songName);
    }

    // Task 9: Get unique identifier for a song - YouTube ID for YT songs, filename (sans extension) for others
    getSongIdentifier(songName) {
        const ytMatch = songName.match(/\(([\w-]{11})\)\.[^.]+$/i);
        if (ytMatch) return ytMatch[1];
        // Return filename without extension for non-YouTube songs
        return songName.replace(/\.[^.]+$/, '');
    }

    // Task 21: Bidirectional wildcard match (_ matches any char in query OR target)
    bidirectionalMatch(query, target) {
        if (!query) return true;
        if (!target) return false;
        const q = query.toLowerCase();
        const t = target.toLowerCase();
        const qLen = q.length;
        const tLen = t.length;

        // Substring search
        for (let o = 0; o <= tLen - qLen; o++) {
            let match = true;
            for (let i = 0; i < qLen; i++) {
                const qc = q[i];
                const tc = t[o + i];
                if (qc !== '_' && tc !== '_' && qc !== tc) {
                    match = false;
                    break;
                }
            }
            if (match) return true;
        }
        return false;
    }

    togglePlayPause() {
        if (!this.currentSong) {
            this.playCurrentSong();
            return;
        }

        if (this.isPlaying) {
            if (this.isPaused) {
                this.audioPlayer.play();
                this.isPaused = false;
            } else {
                this.audioPlayer.pause();
                this.isPaused = true;
            }
        } else {
            this.audioPlayer.play();
            this.isPlaying = true;
            this.isPaused = false;
        }
        this.updateMediaSessionState();
    }

    stopSong() {
        this.audioPlayer.pause();
        this.audioPlayer.currentTime = 0;
        this.isPlaying = false;
        this.isPaused = false;
    }

    previousSong() {
        if (this.songPermutation.length > 0) {
            this.currentSongIndex = (this.currentSongIndex - 1 + this.songPermutation.length) % this.songPermutation.length;
            this.playCurrentSong();
        }
    }

    nextSong() {
        if (this.songPermutation.length > 0) {
            this.currentSongIndex = (this.currentSongIndex + 1) % this.songPermutation.length;
            this.playCurrentSong();
        }
    }

    songFinished() {
        this.isPlaying = false;
        this.isPaused = false;
        if (this.autoNextEnabled) {
            this.nextSong();
        }
    }

    openInPlayer() {
        if (!this.currentSong) return;
        window.electronAPI.openPath(this.currentSong.path);
    }

    openInYouTube() {
        if (!this.currentSong) return;
        const url = `https://www.youtube.com/watch?v=${this.currentSong.videoId}`;
        window.electronAPI.openExternal(url);
    }

    renderClassifications() {
        const container = document.getElementById('classificationsContent');
        if (!container) return;
        container.innerHTML = '';

        for (const column of this.classificationColumns) {
            const columnDiv = document.createElement('div');
            columnDiv.className = 'classification-column';

            const header = document.createElement('div');
            header.className = 'column-header';
            header.textContent = `Select ${column.name}`;
            columnDiv.appendChild(header);

            const content = document.createElement('div');
            content.className = 'column-content';

            for (const value of column.values) {
                const item = document.createElement('div');
                item.className = 'radio-item';

                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = column.name;
                radio.value = value;
                radio.id = `${column.name}_${value}`;

                const label = document.createElement('label');
                label.htmlFor = radio.id;
                label.textContent = value;

                item.appendChild(radio);
                item.appendChild(label);
                content.appendChild(item);
            }

            const otherItem = document.createElement('div');
            otherItem.className = 'radio-item';

            const otherRadio = document.createElement('input');
            otherRadio.type = 'radio';
            otherRadio.name = column.name;
            otherRadio.value = 'Other';
            otherRadio.id = `${column.name}_Other`;

            const otherLabel = document.createElement('label');
            otherLabel.htmlFor = otherRadio.id;
            otherLabel.textContent = 'Other';

            otherItem.appendChild(otherRadio);
            otherItem.appendChild(otherLabel);
            content.appendChild(otherItem);

            const otherInput = document.createElement('input');
            otherInput.type = 'text';
            otherInput.className = 'other-input';
            otherInput.id = `${column.name}_other_input`;
            otherInput.placeholder = 'Enter custom value...';
            content.appendChild(otherInput);

            columnDiv.appendChild(content);
            container.appendChild(columnDiv);
        }
    }

    clearClassificationSelections() {
        for (const column of this.classificationColumns) {
            const radios = document.getElementsByName(column.name);
            radios.forEach(radio => radio.checked = false);
            const otherInput = document.getElementById(`${column.name}_other_input`);
            if (otherInput) otherInput.value = '';
        }
    }

    loadClassificationSelections(videoId) {
        const classifications = this.classifiedSongs[videoId];
        if (!classifications) return;
        for (const column of this.classificationColumns) {
            const value = classifications[column.name];
            if (value) {
                const radio = document.querySelector(`input[name="${column.name}"][value="${value}"]`);
                if (radio) {
                    radio.checked = true;
                } else {
                    // It's an "Other" value
                    const otherRadio = document.getElementById(`${column.name}_Other`);
                    if (otherRadio) otherRadio.checked = true;
                    const otherInput = document.getElementById(`${column.name}_other_input`);
                    if (otherInput) otherInput.value = value;
                }
            }
        }
    }

    async saveClassification() {
        if (!this.currentSong) return;
        const classifications = {};
        for (const column of this.classificationColumns) {
            const radios = document.getElementsByName(column.name);
            let selectedValue = null;
            for (const radio of radios) {
                if (radio.checked) {
                    selectedValue = radio.value;
                    break;
                }
            }
            if (selectedValue === 'Other') {
                const otherInput = document.getElementById(`${column.name}_other_input`);
                selectedValue = otherInput.value;
                if (!selectedValue.trim()) {
                    alert(`Please enter a value for ${column.name} 'Other' field.`);
                    return;
                }
            }
            if (!selectedValue) {
                alert(`Please select a ${column.name}.`);
                return;
            }
            classifications[column.name] = selectedValue;
        }

        const videoId = this.currentSong.videoId;
        this.classifiedSongs[videoId] = classifications;

        const fileIndex = this.unclassifiedSongs.indexOf(this.currentSong.fileName);
        if (fileIndex !== -1) {
            this.unclassifiedSongs.splice(fileIndex, 1);
        }

        // Silent save to current CSV
        if (this.config.lastCSVFile) {
            const headers = ['video_id', ...this.classificationColumns.map(col => col.name)];
            let csvContent = headers.join(',') + '\n';
            for (const [vid, classifs] of Object.entries(this.classifiedSongs)) {
                const row = [vid];
                for (const column of this.classificationColumns) {
                    const value = classifs[column.name] || '';
                    const escapedValue = `"${value.toString().replace(/"/g, '""')}"`;
                    row.push(escapedValue);
                }
                csvContent += row.join(',') + '\n';
            }
            await window.electronAPI.saveCSV(this.config.lastCSVFile, csvContent);
        }
        this.updateStats();
        this.nextSong();
    }

    updateStats() {
        const totalClassified = Object.keys(this.classifiedSongs).length;
        const totalSongs = this.allSongNames.length;
        const stats = document.getElementById('stats');
        if (stats) {
            stats.innerHTML = `Classified: ${totalClassified}/<b>${totalSongs}</b>`;
        }
    }

    openPermutationModal() {
        if (this.classificationColumns.length === 0) {
            alert('No classification columns defined.');
            return;
        }

        // Only render if not already rendered to persist choices
        const container = document.getElementById('permutationContent');
        if (container && container.innerHTML === '') {
            this.renderPermutationModal();
        }

        document.getElementById('permutationModal').style.display = 'block';
    }

    closePermutationModal() {
        document.getElementById('permutationModal').style.display = 'none';
    }

    openPlaylistModal() {
        this.renderPlaylistList();
        document.getElementById('playlistModal').style.display = 'block';
    }

    closePlaylistModal() {
        document.getElementById('playlistModal').style.display = 'none';
        this.updateSelectedPlaylistsCount();
    }

    updateSelectedPlaylistsCount() {
        const countSpan = document.getElementById('selectedPlaylistsCount');
        if (countSpan) {
            countSpan.textContent = this.selectedPlaylists.length > 0
                ? `${this.selectedPlaylists.length} playlists selected`
                : 'None selected';
        }
    }

    renderPlaylistList() {
        const list = document.getElementById('playlistList');
        if (!list) return;

        const searchInput = document.getElementById('playlistSearch');
        const sortSelect = document.getElementById('playlistSortSelect');

        const filterText = searchInput ? searchInput.value.toLowerCase() : '';
        const sortBy = sortSelect ? sortSelect.value : 'name';

        list.innerHTML = '';

        // FIX: Add special rows at the top for non-YouTube and no-playlist filtering
        // Standardize: Use 'id' consistently for all rows
        const specialRows = [
            { id: '__ON_NO_PLAYLIST__', displayName: 'On No Playlist', count: 0 },
            { id: '__NOT_FROM_YOUTUBE__', id: '__NOT_FROM_YOUTUBE__', displayName: 'Not From YouTube', count: 0 }
        ];

        // Count non-YouTube songs
        let nonYtCount = 0;
        for (const song of this.allSongNames) {
            if (!this.isYouTubeSong(song.name)) nonYtCount++;
        }
        specialRows[1].count = nonYtCount;

        // Count songs not in any playlist (YouTube only)
        const songsInPlaylistsSet = new Set();
        for (const pl of this.allPlaylists) {
            if (pl.songs) {
                for (const s of pl.songs) {
                    songsInPlaylistsSet.add(this.getSongIdentifier(s));
                }
            }
        }
        let noPlaylistCount = 0;
        const noPlaylistSongNames = [];
        for (const song of this.allSongNames) {
            if (this.isYouTubeSong(song.name)) {
                const id = this.getSongIdentifier(song.name);
                if (!songsInPlaylistsSet.has(id)) {
                    noPlaylistCount++;
                    noPlaylistSongNames.push(song.name);
                }
            }
        }

        // Diagnostic log: show first 50 songs on no playlist
        if (noPlaylistSongNames.length > 0) {
            console.log(`[Diagnostic] Songs on "On No Playlist": ${noPlaylistSongNames.length}`);
            console.log(`[Diagnostic] Sample:`, noPlaylistSongNames.slice(0, 50));
        }

        specialRows[0].count = noPlaylistCount;

        // Render special rows
        specialRows.forEach((sp) => {
            const item = document.createElement('div');
            item.className = 'playlist-item checkbox-item';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.padding = '5px';
            item.style.cursor = 'pointer';
            item.style.backgroundColor = '#2a2a2a';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = this.selectedPlaylists.includes(sp.id);
            cb.style.marginRight = '8px';

            const toggle = (isChecked) => {
                cb.checked = isChecked;
                if (isChecked) {
                    if (!this.selectedPlaylists.includes(sp.id)) this.selectedPlaylists.push(sp.id);
                } else {
                    this.selectedPlaylists = this.selectedPlaylists.filter(p => p !== sp.id);
                }
                this.updateSelectedPlaylistsCount();
            };

            cb.onclick = (e) => {
                e.stopPropagation();
                toggle(cb.checked);
            };
            item.onclick = (e) => {
                if (e.target !== cb) {
                    cb.dispatchEvent(new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        shiftKey: e.shiftKey
                    }));
                }
            };

            const label = document.createElement('div');
            label.style.flex = '1';
            label.style.display = 'flex';
            label.style.justifyContent = 'space-between';
            label.style.fontStyle = 'italic';
            label.innerHTML = `<span style="color: #aaa;">${sp.displayName}</span> <span style="color: #666;">${sp.count} songs</span>`;

            item.appendChild(cb);
            item.appendChild(label);
            list.appendChild(item);
        });

        // Removed separator line as requested

        // Filter with wildcard support (_ matches any character in BOTH directions)
        let filtered = this.allPlaylists;
        if (filterText) {
            filtered = this.allPlaylists.filter(pl => this.bidirectionalMatch(filterText, pl.name));
        }

        const sorted = filtered.sort((a, b) => {
            if (sortBy === 'name') return a.name.localeCompare(b.name);
            if (sortBy === 'count') return b.count - a.count;
            return 0;
        });

        sorted.forEach((pl, index) => {
            const item = document.createElement('div');
            item.className = 'playlist-item checkbox-item';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.padding = '5px';
            item.style.cursor = 'pointer';
            item.style.userSelect = 'none';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = this.selectedPlaylists.includes(pl.id);
            cb.style.marginRight = '8px';

            const doClick = (targetChecked) => {
                cb.checked = targetChecked;
                if (targetChecked) {
                    if (!this.selectedPlaylists.includes(pl.id)) this.selectedPlaylists.push(pl.id);
                } else {
                    this.selectedPlaylists = this.selectedPlaylists.filter(p => p !== pl.id);
                }
                this.lastPlaylistClickIndex = index;
                this.lastPlaylistClickAction = targetChecked;
                this.updateSelectedPlaylistsCount();

                // Auto-sync Select All state
                const selectAllCb = document.getElementById('selectAllPlaylists');
                if (selectAllCb) {
                    const allChecked = filtered.every(pl => this.selectedPlaylists.includes(pl.id));
                    selectAllCb.checked = allChecked;
                }
            };

            cb.onclick = (e) => {
                e.stopPropagation();
                const isChecked = cb.checked;

                if (e.shiftKey && this.lastPlaylistClickIndex !== undefined && this.lastPlaylistClickIndex !== index) {
                    const action = this.lastPlaylistClickAction;
                    const start = Math.min(this.lastPlaylistClickIndex, index);
                    const end = Math.max(this.lastPlaylistClickIndex, index);

                    for (let i = start; i <= end; i++) {
                        const plId = sorted[i].id;
                        if (action) {
                            if (!this.selectedPlaylists.includes(plId)) this.selectedPlaylists.push(plId);
                        } else {
                            this.selectedPlaylists = this.selectedPlaylists.filter(p => p !== plId);
                        }
                    }
                    this.lastPlaylistClickIndex = index;
                    this.renderPlaylistList();
                } else {
                    if (isChecked) {
                        if (!this.selectedPlaylists.includes(pl.id)) this.selectedPlaylists.push(pl.id);
                    } else {
                        this.selectedPlaylists = this.selectedPlaylists.filter(p => p !== pl.id);
                    }
                    this.lastPlaylistClickIndex = index;
                    this.lastPlaylistClickAction = isChecked;
                    this.updateSelectedPlaylistsCount();

                    const selectAllCb = document.getElementById('selectAllPlaylists');
                    if (selectAllCb) {
                        const allChecked = filtered.every(pl => this.selectedPlaylists.includes(pl.id));
                        selectAllCb.checked = allChecked;
                    }
                }
            };

            const label = document.createElement('div');
            label.style.flex = '1';
            label.style.display = 'flex';
            label.style.justifyContent = 'space-between';
            label.innerHTML = `<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; padding-right: 10px;">${pl.name}</span> <span style="color: #888; white-space: nowrap; flex-shrink: 0;">${pl.count} songs</span>`;

            item.onclick = (e) => {
                if (e.target.closest('button')) return;
                cb.dispatchEvent(new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    shiftKey: e.shiftKey
                }));
            };

            item.appendChild(cb);
            item.appendChild(label);
            list.appendChild(item);
        });

        // Update select all checkbox state at the end of rendering
        const selectAllCb = document.getElementById('selectAllPlaylists');
        if (selectAllCb) {
            const allChecked = filtered.length > 0 && filtered.every(pl => this.selectedPlaylists.includes(pl.id));
            selectAllCb.checked = allChecked;
        }
    }

    selectAllPlaylists(checked) {
        const searchInput = document.getElementById('playlistSearch');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        // Filter playlists by search if active
        let filtered = this.allPlaylists;
        if (searchTerm) {
            filtered = this.allPlaylists.filter(pl => this.bidirectionalMatch(searchTerm, pl.name));
        }

        if (checked) {
            for (const pl of filtered) {
                if (!this.selectedPlaylists.includes(pl.id)) {
                    this.selectedPlaylists.push(pl.id);
                }
            }
        } else {
            const visibleIds = new Set(filtered.map(p => p.id));
            this.selectedPlaylists = this.selectedPlaylists.filter(id => !visibleIds.has(id));
        }
        this.renderPlaylistList();
    }

    // Song selection modal functions
    openSongModal() {
        this.renderSongList();
        document.getElementById('songModal').style.display = 'block';
    }

    closeSongModal() {
        document.getElementById('songModal').style.display = 'none';
        this.updateSelectedSongsCount();
    }

    updateSelectedSongsCount() {
        const countSpan = document.getElementById('selectedSongsCount');
        if (countSpan) {
            countSpan.textContent = this.selectedSongs.length > 0
                ? `${this.selectedSongs.length} songs selected`
                : 'None selected';
        }
    }

    renderSongList() {
        const list = document.getElementById('songList');
        if (!list) return;

        const searchInput = document.getElementById('songSearch');
        const sortSelect = document.getElementById('songSortSelect');

        const filterText = searchInput ? searchInput.value.toLowerCase() : '';
        const sortBy = sortSelect ? sortSelect.value : 'name';

        list.innerHTML = '';

        const songsData = this.allSongNames
            .map(s => {
                const identifier = this.getSongIdentifier(s.name);
                const match = s.name.match(this.getSongMatchPattern());
                const title = match ? match[1].trim() : s.name.replace(/\.[^.]+$/, '');
                const key = this.getConfigKey(s.name);
                const duration = this.songDurations[key] || 0;
                return { name: s.name, videoId: identifier, title, duration };
            });

        // Filter with wildcard support (_ matches any character in BOTH directions)
        let filtered = songsData;
        if (filterText) {
            filtered = songsData.filter(s => this.bidirectionalMatch(filterText, s.title) || this.bidirectionalMatch(filterText, s.videoId));
        }

        const sorted = filtered.sort((a, b) => {
            if (sortBy === 'name') return a.title.localeCompare(b.title);
            if (sortBy === 'duration') return b.duration - a.duration;
            return 0;
        });

        sorted.forEach((song, index) => {
            const item = document.createElement('div');
            item.className = 'playlist-item checkbox-item';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.padding = '5px';
            item.style.cursor = 'pointer';
            item.style.userSelect = 'none';

            // Checkbox
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = this.selectedSongs.includes(song.videoId);
            cb.style.marginRight = '8px';

            cb.onclick = (e) => {
                e.stopPropagation();
                const isChecked = cb.checked;

                if (e.shiftKey && this.lastSongClickIndex !== undefined && this.lastSongClickIndex !== index) {
                    const action = this.lastSongClickAction;
                    const start = Math.min(this.lastSongClickIndex, index);
                    const end = Math.max(this.lastSongClickIndex, index);

                    for (let i = start; i <= end; i++) {
                        const vid = sorted[i].videoId;
                        if (action) {
                            if (!this.selectedSongs.includes(vid)) this.selectedSongs.push(vid);
                        } else {
                            this.selectedSongs = this.selectedSongs.filter(s => s !== vid);
                        }
                    }
                    this.lastSongClickIndex = index;
                    this.renderSongList();
                } else {
                    if (isChecked) {
                        if (!this.selectedSongs.includes(song.videoId)) this.selectedSongs.push(song.videoId);
                    } else {
                        this.selectedSongs = this.selectedSongs.filter(s => s !== song.videoId);
                    }
                    this.lastSongClickIndex = index;
                    this.lastSongClickAction = isChecked;
                    this.updateSelectedSongsCount();

                    const selectAllCb = document.getElementById('selectAllSongs');
                    if (selectAllCb) {
                        const allChecked = filtered.every(s => this.selectedSongs.includes(s.videoId));
                        selectAllCb.checked = allChecked;
                    }
                }
            };

            const label = document.createElement('div');
            label.style.flex = '1';
            label.style.display = 'flex';
            label.style.justifyContent = 'space-between';
            label.style.minWidth = '0';
            label.style.overflow = 'hidden';
            const durationStr = song.duration ? this.formatTime(song.duration) : '';
            label.innerHTML = `<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; padding-right: 10px;">${song.title}</span> <span style="color: #888; white-space: nowrap; flex-shrink: 0;">${durationStr}</span>`;

            item.onclick = (e) => {
                if (e.target.closest('button')) return;
                cb.dispatchEvent(new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    shiftKey: e.shiftKey
                }));
            };

            item.appendChild(cb);
            item.appendChild(label);
            list.appendChild(item);
        });

        // Update select all checkbox state at the end of rendering
        const selectAllCb = document.getElementById('selectAllSongs');
        if (selectAllCb) {
            const allChecked = filtered.length > 0 && filtered.every(s => this.selectedSongs.includes(s.videoId));
            selectAllCb.checked = allChecked;
        }
    }

    selectAllSongs(checked) {
        const searchInput = document.getElementById('songSearch');
        const filterText = searchInput ? searchInput.value.toLowerCase().trim() : '';

        // FIX: Include ALL songs
        const songsData = this.allSongNames
            .map(s => {
                const identifier = this.getSongIdentifier(s.name);
                const match = s.name.match(this.getSongMatchPattern());
                const title = match ? match[1].trim() : s.name.replace(/\.[^.]+$/, '');
                return { name: s.name, videoId: identifier, title };
            });

        // Filter by search if active (with wildcard support)
        let filtered = songsData;
        if (filterText) {
            filtered = songsData.filter(s => this.bidirectionalMatch(filterText, s.title) || this.bidirectionalMatch(filterText, s.videoId));
        }

        if (checked) {
            for (const s of filtered) {
                if (!this.selectedSongs.includes(s.videoId)) {
                    this.selectedSongs.push(s.videoId);
                }
            }
        } else {
            const visibleIds = new Set(filtered.map(s => s.videoId));
            this.selectedSongs = this.selectedSongs.filter(id => !visibleIds.has(id));
        }
        this.renderSongList();
    }

    renderPermutationModal() {
        const container = document.getElementById('permutationContent');
        if (!container) return;
        container.innerHTML = '';

        for (const column of this.classificationColumns) {
            const columnDiv = document.createElement('div');
            columnDiv.className = 'classification-column';

            const header = document.createElement('div');
            header.className = 'column-header';
            header.textContent = `Select ${column.name}`;
            columnDiv.appendChild(header);

            const content = document.createElement('div');
            content.className = 'column-content';

            // Helper to update Select All checkbox state
            const updateSelectAllState = () => {
                const checkboxes = content.querySelectorAll('input[type="checkbox"]:not([id$="_SelectAll"])');
                const allChecked = Array.from(checkboxes).every(cb => cb.checked);
                const selectAllCheck = content.querySelector('input[id$="_SelectAll"]');
                if (selectAllCheck) selectAllCheck.checked = allChecked;
            };

            // Select All
            const selectAllItem = document.createElement('div');
            selectAllItem.className = 'checkbox-item';
            const selectAllCheck = document.createElement('input');
            selectAllCheck.type = 'checkbox';
            selectAllCheck.id = `perm_${column.name}_SelectAll`;
            const selectAllLabel = document.createElement('label');
            selectAllLabel.htmlFor = selectAllCheck.id;
            selectAllLabel.textContent = 'Select all';

            selectAllCheck.addEventListener('change', (e) => {
                const checkboxes = content.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => { if (cb !== selectAllCheck) cb.checked = e.target.checked; });
            });

            selectAllItem.appendChild(selectAllCheck);
            selectAllItem.appendChild(selectAllLabel);
            content.appendChild(selectAllItem);

            const separator = document.createElement('div');
            separator.className = 'separator';
            content.appendChild(separator);

            // Row rendering helper
            const renderRow = (value, displayName) => {
                const item = document.createElement('div');
                item.className = 'checkbox-item';
                item.style.cursor = 'pointer';
                item.style.userSelect = 'none';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `perm_${column.name}_${value}`;
                checkbox.dataset.value = value;
                checkbox.checked = true; // Default to checked

                const label = document.createElement('label');
                label.htmlFor = checkbox.id;
                label.textContent = displayName;
                label.style.pointerEvents = 'none';

                checkbox.onclick = (e) => {
                    e.stopPropagation();
                    const isChecked = checkbox.checked;
                    const rowItems = Array.from(content.querySelectorAll('.checkbox-item')).filter(i => !i.querySelector('[id$="_SelectAll"]'));
                    const currentIndex = rowItems.indexOf(item);

                    if (e.shiftKey && content.dataset.lastClickIndex !== undefined) {
                        const action = content.dataset.lastClickAction === 'true';
                        const start = Math.min(parseInt(content.dataset.lastClickIndex), currentIndex);
                        const end = Math.max(parseInt(content.dataset.lastClickIndex), currentIndex);

                        for (let i = start; i <= end; i++) {
                            const cb = rowItems[i].querySelector('input[type="checkbox"]');
                            if (cb) cb.checked = action;
                        }
                        content.dataset.lastClickIndex = currentIndex;
                        updateSelectAllState();
                    } else {
                        content.dataset.lastClickIndex = currentIndex;
                        content.dataset.lastClickAction = isChecked;
                        updateSelectAllState();
                    }
                };

                item.onclick = (e) => {
                    checkbox.dispatchEvent(new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        shiftKey: e.shiftKey
                    }));
                };
                item.appendChild(checkbox);
                item.appendChild(label);
                content.appendChild(item);
            };

            // Unclassified
            renderRow('Unclassified', 'Unclassified');

            // Values
            for (const value of column.values) {
                renderRow(value, value);
            }

            // Other
            renderRow('Other', 'Other (everything else)');

            columnDiv.appendChild(content);
            container.appendChild(columnDiv);
            updateSelectAllState();
        }
    }
    async createPermutation() {
        const criteria = {};
        for (const column of this.classificationColumns) {
            const checks = Array.from(document.querySelectorAll(`input[id^="perm_${column.name}_"]:checked`))
                .filter(c => !c.id.endsWith('_SelectAll'))
                .map(c => c.dataset.value);
            criteria[column.name] = checks;
        }

        let filteredSongs = this.allSongNames.map(s => s.name);

        // Filter by Playlist if selected
        // FIX: Use getSongIdentifier to support non-YouTube songs
        if (this.selectedPlaylists.length > 0) {
            const playlistSongIdSet = new Set();

            for (const plId of this.selectedPlaylists) {
                // Handle special pseudo-playlists
                if (plId === '__NOT_FROM_YOUTUBE__') {
                    // Add all non-YouTube songs
                    for (const song of this.allSongNames) {
                        if (!this.isYouTubeSong(song.name)) {
                            playlistSongIdSet.add(this.getSongIdentifier(song.name));
                        }
                    }
                    continue;
                }
                if (plId === '__ON_NO_PLAYLIST__') {
                    // Add songs that are NOT in any playlist (YouTube only)
                    const songsInPlaylists = new Set();
                    for (const pl of this.allPlaylists) {
                        if (pl.songs) {
                            for (const s of pl.songs) {
                                songsInPlaylists.add(this.getSongIdentifier(s));
                            }
                        }
                    }
                    for (const song of this.allSongNames) {
                        const id = this.getSongIdentifier(song.name);
                        if (this.isYouTubeSong(song.name) && !songsInPlaylists.has(id)) {
                            playlistSongIdSet.add(id);
                        }
                    }
                    continue;
                }

                // Normal playlist - Find by ID
                const pl = this.allPlaylists.find(p => p.id === plId);
                if (pl && pl.songs) {
                    for (const songName of pl.songs) {
                        playlistSongIdSet.add(this.getSongIdentifier(songName));
                    }
                }
            }

            console.log(`Playlist Filtering: Unique song IDs in selected playlists: ${playlistSongIdSet.size}`);
            const beforeCount = filteredSongs.length;
            filteredSongs = filteredSongs.filter(name => {
                const id = this.getSongIdentifier(name);
                return playlistSongIdSet.has(id);
            });
            console.log(`Filtered from ${beforeCount} to ${filteredSongs.length} songs based on playlist.`);
        }

        // Filter by selected songs if specified
        // FIX: Use getSongIdentifier for non-YouTube support
        if (this.selectedSongs.length > 0) {
            const songIdSet = new Set(this.selectedSongs);
            const beforeCount = filteredSongs.length;
            filteredSongs = filteredSongs.filter(name => {
                const id = this.getSongIdentifier(name);
                return songIdSet.has(id);
            });
            console.log(`Filtered from ${beforeCount} to ${filteredSongs.length} songs based on selected songs.`);
        }

        // Filter by traditional criteria
        // FIX: Use getSongIdentifier to support both YouTube and non-YouTube songs
        filteredSongs = filteredSongs.filter(songName => {
            const identifier = this.getSongIdentifier(songName);
            const classifs = this.classifiedSongs[identifier] || {};

            for (const column of this.classificationColumns) {
                const allowed = criteria[column.name];
                if (allowed && allowed.length > 0) {
                    const value = classifs[column.name] || 'Unclassified';

                    // Special "Other" logic: if "Other" is checked, we also allow values NOT in the allowed list
                    const hasOther = document.getElementById(`perm_${column.name}_Other`)?.checked;

                    if (hasOther) {
                        // If it's not unclassified and not one of the standard values, it counts as "Other"
                        if (value !== 'Unclassified' && !column.values.includes(value)) {
                            continue; // Matches "Other", move to next column
                        }
                    }

                    if (!allowed.includes(value)) return false;
                }
            }
            return true;
        });

        // Helper: Parse duration input (supports "4.08" or "4:05")
        const parseDuration = (val) => {
            if (!val || val.trim() === '') return NaN;
            if (val.includes(':')) {
                const parts = val.split(':');
                const min = parseFloat(parts[0]) || 0;
                const sec = parseFloat(parts[1]) || 0;
                return min + (sec / 60);
            }
            return parseFloat(val);
        };

        const minDur = parseDuration(document.getElementById('minDuration')?.value);
        const maxDur = parseDuration(document.getElementById('maxDuration')?.value);

        if (!isNaN(minDur) || !isNaN(maxDur)) {
            console.log(`Filtering by duration: min=${minDur}, max=${maxDur}`);
            const originalCount = filteredSongs.length;
            const durationFiltered = [];

            // With startup scan, we assume durations are populated.
            // But checking just in case
            for (let i = 0; i < filteredSongs.length; i++) {
                const songName = filteredSongs[i];
                let duration = this.songDurations[songName];

                // Fallback probe if somehow missing (should be rare/impossible with startup scan)
                if (duration === undefined) {
                    const filePath = this.getFileForSong(songName);
                    if (filePath) {
                        // Synchronous-like via await for individual file fallback
                        try {
                            duration = await window.electronAPI.getDuration(filePath);
                            if (duration) this.songDurations[songName] = duration;
                        } catch (e) { }
                    }
                }

                if (duration !== undefined && duration !== null) {
                    const durMin = duration / 60;
                    let match = true;
                    if (!isNaN(minDur) && durMin < minDur) match = false;
                    if (!isNaN(maxDur) && durMin > maxDur) match = false;
                    if (match) durationFiltered.push(songName);
                }
            }

            filteredSongs = durationFiltered;
            console.log(`Duration Filtering: ${originalCount} -> ${filteredSongs.length}`);
        }


        if (filteredSongs.length === 0) {
            alert('No songs match these criteria.');
            return;
        }

        this.songPermutation = this.shuffleArray(filteredSongs);
        this.currentSongIndex = 0;
        this.closePermutationModal();

        // FORCE SIDEBAR RE-RENDER: Clear the sidebar HTML entirely
        // This ensures the next playSong() call will consider the sidebar "not rendered"
        // and trigger a full renderThumbnailSidebar() in the new correct order.
        const sidebar = document.getElementById('thumbnailSidebar');
        if (sidebar) sidebar.innerHTML = '';

        this.playCurrentSong();
        this.updateStats();
    }

    async exportConfig() {
        const criteria = {};
        for (const column of this.classificationColumns) {
            const checks = Array.from(document.querySelectorAll(`input[id^="perm_${column.name}_"]:checked`))
                .filter(c => !c.id.endsWith('_SelectAll'))
                .map(c => c.dataset.value);
            criteria[column.name] = checks;
        }

        const json = JSON.stringify({
            criteria,
            selectedPlaylists: this.selectedPlaylists,
            selectedSongs: this.selectedSongs,
            minDuration: document.getElementById('minDuration')?.value,
            maxDuration: document.getElementById('maxDuration')?.value
        }, null, 2);
        const result = await window.electronAPI.showSaveDialog({
            title: 'Export Permutation Config',
            defaultPath: this.config.lastPermutationFile || (this.musicDirectory ? `${this.musicDirectory}/permutation_config.json` : 'permutation_config.json'),
            filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });

        if (!result.canceled && result.filePath) {
            const success = await window.electronAPI.saveCSV(result.filePath, json);
            if (success) {
                this.config.lastPermutationFile = result.filePath;
                await this.saveConfig();
            }
        }
    }

    async importConfig() {
        const filePath = await window.electronAPI.selectFile([{ name: 'JSON Files', extensions: ['json'] }]);
        if (!filePath) return;
        await this.importConfigFromPath(filePath);
    }

    async importConfigFromPath(filePath) {
        try {
            const text = await window.electronAPI.readFile(filePath);
            const data = JSON.parse(text);
            const criteria = data.criteria || data; // Handle old format

            // Render modal first if needed (even if hidden) to ensure checkboxes exist
            const container = document.getElementById('permutationContent');
            if (container && container.innerHTML === '') {
                this.renderPermutationModal();
            }

            for (const [columnName, selectedValues] of Object.entries(criteria)) {
                // First uncheck all (including Select All)
                const allChecks = document.querySelectorAll(`input[id^="perm_${columnName}_"]`);
                allChecks.forEach(c => c.checked = false);

                // Check specific values
                for (const value of selectedValues) {
                    const cb = document.getElementById(`perm_${columnName}_${value}`);
                    if (cb) cb.checked = true;
                }

                // Update Select All state
                const selectAllCb = document.getElementById(`perm_${columnName}_SelectAll`);
                if (selectAllCb) {
                    const checkboxes = Array.from(document.querySelectorAll(`input[id^="perm_${columnName}_"]:not([id$="_SelectAll"])`));
                    if (checkboxes.length > 0 && checkboxes.every(cb => cb.checked)) {
                        selectAllCb.checked = true;
                    }
                }
            }

            if (data.selectedPlaylists) {
                this.selectedPlaylists = data.selectedPlaylists;
            } else {
                this.selectedPlaylists = [];
            }
            this.updateSelectedPlaylistsCount();

            if (data.selectedSongs) {
                this.selectedSongs = data.selectedSongs;
            } else {
                this.selectedSongs = [];
            }
            this.updateSelectedSongsCount();

            if (data.minDuration !== undefined) {
                const el = document.getElementById('minDuration');
                if (el) el.value = data.minDuration || '';
            } else {
                const el = document.getElementById('minDuration');
                if (el) el.value = '';
            }
            if (data.maxDuration !== undefined) {
                const el = document.getElementById('maxDuration');
                if (el) el.value = data.maxDuration || '';
            } else {
                const el = document.getElementById('maxDuration');
                if (el) el.value = '';
            }

            this.config.lastPermutationFile = filePath;
            await this.saveConfig();
        } catch (err) {
            console.error('Could not import config:', err);
            if (!this.config.lastPermutationFile) alert('Could not import config: ' + err.message);
        }
    }

    // =========================================================================
    // YouTube Backup Integration Methods
    // =========================================================================

    async initYTBackup() {
        if (this.ytBackupPromise) return this.ytBackupPromise;

        this.ytBackupPromise = (async () => {
            try {
                const appPath = await window.electronAPI.getAppPath();
                const ytBackup = new YTBackup(appPath);

                // Set progress callback
                // Set progress callback
                ytBackup.onProgress = (data) => {
                    // Check if data is object {status, itemName, percentage} or legacy string
                    const isObj = typeof data === 'object' && data !== null;
                    const statusText = isObj ? data.status : "Working";
                    const itemText = isObj ? data.itemName : data;
                    const pct = isObj ? data.percentage : -1;

                    // Update Labels
                    const lblStatus = document.getElementById('backupStatusLabel');
                    const lblItem = document.getElementById('backupItemName');
                    if (lblStatus) lblStatus.textContent = statusText;
                    if (lblItem) lblItem.textContent = itemText;
                    if (lblItem) lblItem.title = itemText; // Tooltip for long names

                    // Update Bar Width
                    // If percentage is -1, maybe show indeterminate or keep previous?
                    // For now, if percentage is provided, use it.
                    if (pct >= 0) {
                        const bar = document.getElementById('backupProgressBar');
                        if (bar) bar.style.width = `${pct}%`;
                    }
                };

                await ytBackup.init();
                this.ytBackup = ytBackup;

                // Task 21: Early Sync if music directory exists
                if (this.musicDirectory) {
                    console.log('[YTBackup] Syncing local files with history...');
                    await ytBackup.syncDownloadsWithDisk(this.musicDirectory);
                    console.log('[YTBackup] Initial Sync complete.');
                }

                return ytBackup;
            } catch (err) {
                console.error('[YTBackup] Global Init Error:', err);
                this.ytBackupPromise = null; // Allow retry
                throw err;
            }
        })();

        return this.ytBackupPromise;
    }

    openBackupModal() {
        const modal = document.getElementById('backupModal');
        if (modal) {
            modal.style.display = 'block';
            this.initYTBackup().then(async (ytBackup) => {
                console.log('[YTBackup] Modal opened. Initializing wrapper...');
                // FORCE reload of data to pick up external changes
                await ytBackup.init();
                console.log('[YTBackup] Settings loaded:', ytBackup.settings);

                // 1. Restore sort type (normalized to lowercase for value matching)
                if (ytBackup.settings.playlist_sort_type) {
                    const sortVal = ytBackup.settings.playlist_sort_type.toLowerCase();
                    console.log('[YTBackup] Restoring sort type:', sortVal);
                    const sortSelect = document.getElementById('backupPlaylistSortSelect');
                    if (sortSelect) {
                        const exists = Array.from(sortSelect.options).some(opt => opt.value === sortVal);
                        if (exists) sortSelect.value = sortVal;
                        else if (sortVal.includes('video')) sortSelect.value = 'count';
                    }
                }

                if (ytBackup.settings.delay_between_downloads) {
                    const delayInput = document.getElementById('downloadDelay');
                    console.log('[YTBackup] Restoring delay:', ytBackup.settings.delay_between_downloads);
                    if (delayInput) delayInput.value = ytBackup.settings.delay_between_downloads;
                }

                // 3. Restore max downloads setting
                if (ytBackup.settings.max_downloads) {
                    const maxDlInput = document.getElementById('maxDownloads');
                    console.log('[YTBackup] Restoring max downloads:', ytBackup.settings.max_downloads);
                    if (maxDlInput) maxDlInput.value = ytBackup.settings.max_downloads;
                }

                // 4. Restore takeout folder and auto-load
                if (ytBackup.settings.takeout_folder) {
                    console.log('[YTBackup] Restoring folder path:', ytBackup.settings.takeout_folder);
                    this.currentTakeoutFolder = ytBackup.settings.takeout_folder;
                    // Auto-load if path is present
                    this.loadBackupPlaylists(ytBackup.settings.takeout_folder).catch(err => {
                        console.error('[YTBackup] Auto-load failed:', err);
                    });
                } else {
                    console.log('[YTBackup] No takeout_folder found in settings.');
                }
            }).catch(err => {
                console.error('[YTBackup] Modal init crash:', err);
                alert('YTBackup failed to initialize: ' + err.message);
            });
        }
    }

    closeBackupModal() {
        const modal = document.getElementById('backupModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    async loadBackupPlaylists(takeoutFolder) {
        console.log('[YTBackup] loadBackupPlaylists called with folder:', takeoutFolder);
        try {
            const ytBackup = await this.initYTBackup();
            console.log('[YTBackup] Instance initialized');

            document.getElementById('backupStatus').textContent = 'Loading playlists...';

            // Save the takeout folder to settings
            ytBackup.settings.takeout_folder = takeoutFolder;
            await ytBackup.saveSettings();
            console.log('[YTBackup] Settings saved');

            // Load playlists from takeout folder
            console.log('[YTBackup] Requesting takeout data loading...');
            this.backupPlaylists = await ytBackup.loadGoogleTakeoutData(takeoutFolder);
            console.log('[YTBackup] Takeout data loaded. Playlists:', Object.keys(this.backupPlaylists).length);

            // Load saved selections - be EXTREMELY picky
            const savedSelections = ytBackup.playlistSelections;
            console.log('[YTBackup] Saved selections count:', Object.keys(savedSelections).length);

            this.backupPlaylistVars = {};
            for (const plId in this.backupPlaylists) {
                // ONLY if explicitly true in JSON
                this.backupPlaylistVars[plId] = (savedSelections[plId] === true);
            }

            const selectedCount = Object.values(this.backupPlaylistVars).filter(v => v === true).length;
            document.getElementById('backupStatus').textContent = `Loaded ${Object.keys(this.backupPlaylists).length} playlists (${selectedCount} pre-selected). Ready.`;

            console.log('[YTBackup] Rendering list...');
            this.renderBackupPlaylistList();
        } catch (err) {
            console.error('[YTBackup] FATAL error in loadBackupPlaylists:', err);
            document.getElementById('backupStatus').textContent = `Error: ${err.message}`;
            alert('Error loading playlists: ' + err.message);
        }
    }

    renderBackupPlaylistList() {
        const container = document.getElementById('backupPlaylistList');
        if (!container) return;

        const playlists = this.backupPlaylists;
        if (!playlists || Object.keys(playlists).length === 0) {
            container.innerHTML = '<div class="backup-placeholder">Load playlists by selecting a Takeout folder above</div>';
            return;
        }

        // Get sort and search settings
        const sortBy = document.getElementById('backupPlaylistSortSelect')?.value || 'count';
        const searchTerm = document.getElementById('backupPlaylistSearch')?.value?.toLowerCase() || '';

        // Convert to array and filter/sort
        let playlistArray = Object.entries(playlists).map(([id, data]) => ({
            id,
            title: data.title,
            count: data.video_ids.length
        }));

        // Filter by search with wildcard support (_ matches any character in BOTH directions)
        if (searchTerm) {
            playlistArray = playlistArray.filter(p => this.bidirectionalMatch(searchTerm, p.title));
        }

        // Sort
        if (sortBy === 'name') {
            playlistArray.sort((a, b) => a.title.localeCompare(b.title));
        } else {
            playlistArray.sort((a, b) => b.count - a.count);
        }

        // Render
        container.innerHTML = '';
        playlistArray.forEach((pl, index) => {
            const div = document.createElement('div');
            div.className = 'playlist-item checkbox-item';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.cursor = 'pointer';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `backup_pl_${pl.id}`;
            checkbox.checked = this.backupPlaylistVars[pl.id] || false;
            checkbox.style.marginRight = '8px';

            // Prevent text selection
            div.style.userSelect = 'none';

            const handleShift = (shouldSelect) => {
                const start = Math.min(this.lastBackupClickIndex, index);
                const end = Math.max(this.lastBackupClickIndex, index);
                for (let i = start; i <= end; i++) {
                    const pid = playlistArray[i].id;
                    this.backupPlaylistVars[pid] = shouldSelect;
                }
                this.lastBackupClickIndex = index;
                this.renderBackupPlaylistList();
            };

            checkbox.onclick = (e) => {
                e.stopPropagation();
                const isChecked = checkbox.checked;

                if (e.shiftKey && this.lastBackupClickIndex !== undefined && this.lastBackupClickIndex !== index) {
                    handleShift(this.lastBackupClickAction);
                } else {
                    this.backupPlaylistVars[pl.id] = isChecked;
                    this.lastBackupClickIndex = index;
                    this.lastBackupClickAction = isChecked;

                    const selectAllCb = document.getElementById('selectAllBackupPlaylists');
                    if (selectAllCb) {
                        const allChecked = playlistArray.every(p => this.backupPlaylistVars[p.id]);
                        selectAllCb.checked = allChecked;
                    }
                }
            };

            const label = document.createElement('div');
            label.style.flex = '1';
            label.style.display = 'flex';
            label.style.justifyContent = 'space-between';
            label.innerHTML = `<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; padding-right: 10px;">${pl.title}</span> <span style="color: #888; white-space: nowrap; flex-shrink: 0;">${pl.count} videos</span>`;

            div.onclick = (e) => {
                if (e.target.closest('button')) return;
                checkbox.dispatchEvent(new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    shiftKey: e.shiftKey
                }));
            };

            div.appendChild(checkbox);
            div.appendChild(label);
            container.appendChild(div);
        });

        // Update select all checkbox state
        const selectAllCb = document.getElementById('selectAllBackupPlaylists');
        if (selectAllCb) {
            const allChecked = playlistArray.length > 0 && playlistArray.every(p => this.backupPlaylistVars[p.id]);
            selectAllCb.checked = allChecked;
        }
    }

    selectAllBackupPlaylists(checked) {
        // Get current search term
        const searchInput = document.getElementById('backupPlaylistSearch');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        // Get all playlist IDs
        let playlistIds = Object.keys(this.backupPlaylists);

        // Filter by search if active
        if (searchTerm) {
            // Support _ as wildcard
            const pattern = searchTerm.replace(/_/g, '.');
            const regex = new RegExp(pattern, 'i');
            playlistIds = playlistIds.filter(id => regex.test(this.backupPlaylists[id].title));
        }

        // Only affect visible playlists
        for (const plId of playlistIds) {
            this.backupPlaylistVars[plId] = checked;
        }
        this.renderBackupPlaylistList();
    }

    selectAllDeleted(checked) {
        const checkboxes = document.querySelectorAll('#deletedList input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = checked);
    }

    getSelectedBackupPlaylists() {
        const selected = {};
        for (const plId in this.backupPlaylists) {
            if (this.backupPlaylistVars[plId]) {
                selected[plId] = this.backupPlaylists[plId];
            }
        }
        return selected;
    }

    async startBackupDownload() {
        const selectedPlaylists = this.getSelectedBackupPlaylists();

        if (Object.keys(selectedPlaylists).length === 0) {
            alert('Please select at least one playlist.');
            return;
        }

        if (!this.musicDirectory) {
            alert('Please set up your music directory first (in the main app).');
            return;
        }

        const ytBackup = await this.initYTBackup();

        // Save current state as defaults for next time
        if (this.ytBackup) {
            const takeoutFolder = this.currentTakeoutFolder || this.ytBackup.settings.takeout_folder || '';
            const sortSelection = document.getElementById('backupPlaylistSortSelect').value;
            const delay = document.getElementById('downloadDelay')?.value || '2';

            this.ytBackup.settings.takeout_folder = takeoutFolder;
            this.ytBackup.settings.playlist_sort_type = sortSelection;
            this.ytBackup.settings.delay_between_downloads = delay;

            await this.ytBackup.saveSettings();
            await this.ytBackup.savePlaylistSelections(this.backupPlaylistVars);
        }

        // Get output folder (parent of music directory)
        const outputFolder = this.musicDirectory.split('/').slice(0, -1).join('/');

        // Update UI
        document.getElementById('backupStatus').textContent = 'Starting download...';

        // Reset progress bars
        const successBar = document.getElementById('backupProgressBarSuccess');
        const failedBar = document.getElementById('backupProgressBarFailed');
        const countsEl = document.getElementById('backupProgressCounts');
        if (successBar) successBar.style.width = '0%';
        if (failedBar) { failedBar.style.width = '0%'; failedBar.style.left = '0%'; }
        if (countsEl) countsEl.innerHTML = `0/<b>${Object.keys(selectedPlaylists).length}</b> | <span style="color: #4CAF50;">Success: 0</span> | <span style="color: #f44336;">Failed: 0</span>`;

        // Task 7: Setup progress bar callback for green/red segments
        ytBackup.onProgressBar = (success, failed, total, songName) => {
            const successPct = (success / total) * 100;
            const failedPct = (failed / total) * 100;

            if (successBar) successBar.style.width = `${successPct}%`;
            if (failedBar) {
                failedBar.style.left = `${successPct}%`;
                failedBar.style.width = `${failedPct}%`;
            }
            if (countsEl) {
                const songPart = songName ? ` | <span style="color: #888; font-weight: normal;">${songName}</span>` : '';
                countsEl.innerHTML = `${success + failed}/<b>${total}</b> | <span style="color: #4CAF50;">Success: ${success}</span> | <span style="color: #f44336;">Failed: ${failed}</span>${songPart}`;
            }
        };

        // Task 18: Clean up text line (remove redundant counts)
        // Task 18 & 19: Clean up text line (remove redundant counts) and handle object progress
        ytBackup.onProgress = (progress) => {
            const nameEl = document.getElementById('backupItemName');
            if (!nameEl) return;

            const text = typeof progress === 'string' ? progress : (progress.raw || "");

            if (text.startsWith('Downloading:')) {
                nameEl.textContent = text.replace('Downloading:', '').trim();
            } else if (text.startsWith('Progress:')) {
                // Ignore progress text as we have the bar/counts
            } else {
                nameEl.textContent = text;
            }
        };

        // Task 21: Build selected playlists map with full objects
        const finalSelectedPlaylists = {};
        for (const plId in this.backupPlaylistVars) {
            if (this.backupPlaylistVars[plId] && this.ytBackup.playlists[plId]) {
                finalSelectedPlaylists[plId] = this.ytBackup.playlists[plId];
            }
        }

        const result = await ytBackup.startDownload(finalSelectedPlaylists, outputFolder);

        if (result.error) {
            document.getElementById('backupStatus').textContent = `Error: ${result.error}`;
        } else {
            document.getElementById('backupStatus').textContent =
                `Complete! Success: ${result.completed}, Failed: ${result.failed}, Skipped: ${result.skipped}`;

            // Task 18: Removed auto-open of deleted modal
        }
    }

    async generatePlaylistDataOnly() {
        const selectedPlaylists = this.getSelectedBackupPlaylists();

        if (Object.keys(selectedPlaylists).length === 0) {
            alert('Please select at least one playlist.');
            return;
        }

        if (!this.musicDirectory) {
            alert('Please set up your music directory first.');
            return;
        }

        const ytBackup = await this.initYTBackup();

        // Save playlist selections
        // Save playlist selections before generating
        await ytBackup.savePlaylistSelections(this.backupPlaylistVars);

        document.getElementById('backupStatus').textContent = 'Generating playlist data...';

        try {
            const outputFolder = this.musicDirectory.split('/').slice(0, -1).join('/');
            const playlistData = await ytBackup.generatePlaylistData(selectedPlaylists, outputFolder);
            const count = Object.keys(playlistData).length;
            document.getElementById('backupStatus').textContent = `Playlist data updated for ${count} playlists.`;

            // Reload playlists in main app
            await this.loadPlaylists();
        } catch (err) {
            document.getElementById('backupStatus').textContent = `Error: ${err.message}`;
        }
    }

    async openUnavailableModal() {
        const modal = document.getElementById('unavailableModal');
        if (!modal) return;

        // Task 21: Show modal immediately for better responsiveness
        modal.style.display = 'block';

        try {
            const ytBackup = await this.initYTBackup();

            // Reload unavailable videos
            ytBackup.unavailableVideos = await ytBackup.loadTrackingData(ytBackup.unavailableVideosFile);

            // Restore sort type
            if (ytBackup.settings.deleted_sort_type) {
                const sortVal = ytBackup.settings.deleted_sort_type.toLowerCase();
                const sortSelect = document.getElementById('unavailableSortSelect');
                if (sortSelect) {
                    if (sortVal.includes('newest')) sortSelect.value = 'newest';
                    else if (sortVal.includes('oldest')) sortSelect.value = 'oldest';
                    else if (sortVal.includes('id')) sortSelect.value = 'id';
                }
            }

            // Task 18: Check file status for dots
            const outputFolder = this.musicDirectory.split('/').slice(0, -1).join('/');
            const audioDir = outputFolder + '/Audio';
            const thumbnailDir = outputFolder + '/Thumbnails';
            try {
                this.unavailableFileStatus = await ytBackup.checkExistingAudio(Array.from(ytBackup.unavailableVideos), audioDir, thumbnailDir);
            } catch (e) {
                console.error('Error checking file status for unavailable:', e);
                this.unavailableFileStatus = {};
            }

            this.renderUnavailableList();
        } catch (err) {
            console.error('[YTBackup] Error opening unavailable modal:', err);
            alert('Failed to load unavailable videos: ' + err.message);
        }
    }

    closeUnavailableModal() {
        const modal = document.getElementById('unavailableModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    async renderUnavailableList() {
        const container = document.getElementById('unavailableList');
        if (!this.ytBackup || !container) return; // Should allow re-rendering if container exists

        try {
            // Robust path handling
            let musicDir = this.musicDirectory || '';
            // Normalize backslashes to forward slashes for consistent splitting
            musicDir = musicDir.replace(/\\/g, '/');

            const parentDir = musicDir.split('/').slice(0, -1).join('/');
            const thumbDir = `${parentDir}/Thumbnails`;

            console.log(`[App] Rendering unavailable. Music: ${musicDir}, Thumb: ${thumbDir}`);
            await this.ytBackup.renderUnavailableVideos(container, musicDir, thumbDir);
        } catch (e) {
            console.error('[App] Error rendering unavailable list:', e);
            container.innerHTML = `<div class="error">Error loading list: ${e.message}</div>`;
        }
    }

    async ignoreSelectedUnavailable() {
        if (!this.ytBackup) return;

        const checkboxes = document.querySelectorAll('#unavailableList input[type="checkbox"]:checked');

        if (checkboxes.length === 0) {
            alert('Please select videos to ignore.');
            return;
        }

        const videoIds = Array.from(checkboxes).map(cb => cb.dataset.videoId);
        await this.ytBackup.ignoreVideos(videoIds);

        this.renderUnavailableList();
    }

    async retrySelectedUnavailable() {
        if (!this.ytBackup) return;

        const checkboxes = document.querySelectorAll('#unavailableList input[type="checkbox"]:checked');

        if (checkboxes.length === 0) {
            alert('Please select videos to retry.');
            return;
        }

        const videoIds = Array.from(checkboxes).map(cb => cb.dataset.videoId);

        // Setup progress bar callback
        const successBar = document.getElementById('backupProgressBarSuccess');
        const failedBar = document.getElementById('backupProgressBarFailed');
        const countsEl = document.getElementById('backupProgressCounts');

        this.ytBackup.onProgressBar = (success, failed, total, songName) => {
            const successPct = (success / total) * 100;
            const failedPct = (failed / total) * 100;
            if (successBar) successBar.style.width = `${successPct}%`;
            if (failedBar) {
                failedBar.style.left = `${successPct}%`;
                failedBar.style.width = `${failedPct}%`;
            }
            if (countsEl) {
                const songPart = songName ? ` | <span style="color: #888; font-weight: normal;">${songName}</span>` : '';
                countsEl.innerHTML = `${success + failed}/<b>${total}</b> | <span style="color: #4CAF50;">Success: ${success}</span> | <span style="color: #f44336;">Failed: ${failed}</span>${songPart}`;
            }
        };

        this.ytBackup.onProgress = (progress) => {
            const nameEl = document.getElementById('backupItemName');
            if (nameEl) {
                const text = typeof progress === 'string' ? progress : (progress.raw || "");
                nameEl.textContent = text.startsWith('Downloading:') ? text.replace('Downloading:', '').trim() : text;
            }
        };

        // Switch to Backup UI to show progress?
        // Actually, just start and when done refresh this list
        this.closeUnavailableModal();
        const outputFolder = this.musicDirectory.split('/').slice(0, -1).join('/');
        await this.ytBackup.startDownload(videoIds, outputFolder, true);
        this.openUnavailableModal();
    }

    // ===== Manually Deleted Files Management =====

    async openDeletedModal() {
        if (!this.musicDirectory) {
            alert('Please select a Music Directory first.');
            return;
        }
        let audioDir, thumbnailDir;
        if (this.musicDirectory.toLowerCase().endsWith('/audio')) {
            audioDir = this.musicDirectory;
            const base = this.musicDirectory.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
            thumbnailDir = base + '/Thumbnails';
        } else {
            const base = this.musicDirectory.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
            audioDir = base + '/Audio';
            thumbnailDir = base + '/Thumbnails';
        }

        console.log('[App] Scanning for deletions in:', audioDir);
        try {
            await this.ytBackup.detectManuallyDeletedFiles(audioDir, thumbnailDir);
        } catch (e) {
            console.error('Error scanning for deletions:', e);
        }

        const modal = document.getElementById('manuallyDeletedModal');
        if (modal) {
            modal.style.display = 'block';
            this.renderDeletedList();
        }
    }

    closeDeletedModal() {
        const modal = document.getElementById('manuallyDeletedModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    async renderDeletedList() {
        if (!this.ytBackup) return;
        const container = document.getElementById('deletedList');

        let audioDir, thumbnailDir;
        if (this.musicDirectory.toLowerCase().endsWith('/audio')) {
            audioDir = this.musicDirectory;
            thumbnailDir = this.musicDirectory.split('/').slice(0, -1).join('/') + '/Thumbnails';
        } else {
            const outputFolder = this.musicDirectory.split('/').slice(0, -1).join('/');
            audioDir = outputFolder + '/Audio';
            thumbnailDir = outputFolder + '/Thumbnails';
        }

        await this.ytBackup.renderDeletedVideos(container, audioDir, thumbnailDir);
    }

    async restoreSelectedDeleted() {
        if (!this.ytBackup) return;

        const checkboxes = document.querySelectorAll('#deletedList input[type="checkbox"]:checked');

        if (checkboxes.length === 0) {
            alert('Please select files to restore.');
            return;
        }

        const videoIds = Array.from(checkboxes).map(cb => cb.dataset.videoId);

        this.closeDeletedModal();

        // Setup progress
        const nameEl = document.getElementById('backupItemName');
        this.ytBackup.onProgress = (progress) => {
            if (nameEl) {
                const text = typeof progress === 'string' ? progress : (progress.raw || "");
                nameEl.textContent = text.startsWith('Downloading:') ? text.replace('Downloading:', '').trim() : text;
            }
        };

        // Setup progress bar callback
        const successBar = document.getElementById('backupProgressBarSuccess');
        const failedBar = document.getElementById('backupProgressBarFailed');
        const countsEl = document.getElementById('backupProgressCounts');

        this.ytBackup.onProgressBar = (success, failed, total, songName) => {
            const successPct = (success / total) * 100;
            const failedPct = (failed / total) * 100;
            if (successBar) successBar.style.width = `${successPct}%`;
            if (failedBar) {
                failedBar.style.left = `${successPct}%`;
                failedBar.style.width = `${failedPct}%`;
            }
            if (countsEl) {
                const songPart = songName ? ` | <span style="color: #888; font-weight: normal;">${songName}</span>` : '';
                countsEl.innerHTML = `${success + failed}/<b>${total}</b> | <span style="color: #4CAF50;">Success: ${success}</span> | <span style="color: #f44336;">Failed: ${failed}</span>${songPart}`;
            }
        };

        // Remove from manuallyDeleted and unavailableVideos sets
        let count = 0;
        for (const videoId of videoIds) {
            if (this.ytBackup.manuallyDeleted.delete(videoId)) {
                this.ytBackup.unavailableVideos.delete(videoId); // Also remove from unavailable list so it can be re-downloaded
                count++;
            }
        }

        await this.ytBackup.saveTrackingData(this.ytBackup.manuallyDeleted, this.ytBackup.manuallyDeletedFile);
        await this.ytBackup.saveTrackingData(this.ytBackup.unavailableVideos, this.ytBackup.unavailableVideosFile);

        const outputFolder = this.musicDirectory.split('/').slice(0, -1).join('/');
        await this.ytBackup.startDownload(videoIds, outputFolder, true);
    }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new MP3CategoryPlayer();
});
