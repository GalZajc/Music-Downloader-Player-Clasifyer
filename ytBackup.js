// ytBackup.js - YouTube Music Backup Tool (JavaScript port from Python)
// Handles downloading YouTube audio from Google Takeout playlists

class YTBackup {
    constructor(appPath) {
        this.appPath = appPath;
        // Normalize path to use forward slashes for consistency
        const normalizedPath = appPath.replace(/\\/g, '/');
        this.dataDir = `${normalizedPath}/YouTube_Backup_Data`;

        // Tracking files
        this.previousDownloadsFile = `${this.dataDir}/previous_downloads.csv`;
        this.manuallyDeletedFile = `${this.dataDir}/manually_deleted.csv`;
        this.unavailableVideosFile = `${this.dataDir}/unavailable_videos.csv`;
        this.ignoredVideosFile = `${this.dataDir}/unavailable_videos_ignore.csv`;
        this.playlistSelectionsFile = `${this.dataDir}/playlist_selections.json`;
        this.settingsFile = `${this.dataDir}/settings.json`;
        this.playlistDataFile = `${this.dataDir}/playlist_data.json`;

        console.log('[YTBackup] Data directory:', this.dataDir);

        // Runtime state
        this.previousDownloads = new Set();
        this.manuallyDeleted = new Set();
        this.unavailableVideos = new Set();
        this.ignoredVideos = new Set();
        this.playlistSelections = {};
        this.settings = {};
        this.playlists = {};

        this.initialized = false;

        // Control flags
        this.stopRequested = false;
        this.pauseRequested = false;

        // Progress callback
        this.onProgress = null;
        this.onProgressBar = null; // Task 7: Callback for progress bar updates with success/failed counts

        this.downloadedInSession = 0;
    }

    // ===== Initialization =====

    async init() {
        console.log('[YTBackup] Initializing data files...');

        // Reload settings and selections explicitly
        this.settings = await this.loadSettings();
        this.playlistSelections = await this.loadPlaylistSelections();

        this.previousDownloads = await this.loadTrackingData(this.previousDownloadsFile);
        this.manuallyDeleted = await this.loadTrackingData(this.manuallyDeletedFile);
        this.unavailableVideos = await this.loadTrackingData(this.unavailableVideosFile);
        this.ignoredVideos = await this.loadTrackingData(this.ignoredVideosFile);

        this.initialized = true;
        console.log('[YTBackup] Initialization complete. Selections loaded:', Object.keys(this.playlistSelections).length);
        console.log('[YTBackup] Settings loaded:', this.settings);
    }

    // ===== Settings =====

    async loadSettings() {
        try {
            const content = await window.electronAPI.readFile(this.settingsFile);
            if (content) {
                return JSON.parse(content);
            }
        } catch (e) {
            console.error('Error loading settings:', e);
        }
        return {};
    }

    async saveSettings() {
        try {
            await window.electronAPI.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2));
        } catch (e) {
            console.error('Error saving settings:', e);
        }
    }

    // ===== Tracking Data (CSV) =====

    async loadTrackingData(filePath) {
        const data = new Set();
        try {
            const content = await window.electronAPI.readFile(filePath);
            if (content) {
                const lines = content.trim().split('\n');
                // Skip header if exists
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line) {
                        data.add(line);
                    }
                }
            }
        } catch (e) {
            console.error(`Error loading ${filePath}:`, e);
        }
        return data;
    }

    async saveTrackingData(data, filePath) {
        try {
            const content = 'video_id\n' + Array.from(data).join('\n');
            await window.electronAPI.writeFile(filePath, content);
        } catch (e) {
            console.error(`Error saving ${filePath}:`, e);
        }
    }

    // ===== Playlist Selections =====

    async loadPlaylistSelections() {
        try {
            const content = await window.electronAPI.readFile(this.playlistSelectionsFile);
            if (content) {
                return JSON.parse(content);
            }
        } catch (e) {
            console.error('Error loading playlist selections:', e);
        }
        return {};
    }

    async savePlaylistSelections(selections) {
        try {
            await window.electronAPI.writeFile(this.playlistSelectionsFile, JSON.stringify(selections, null, 2));
            this.playlistSelections = selections;
        } catch (e) {
            console.error('Error saving playlist selections:', e);
        }
    }

    // ===== Helpers =====

    cleanFilename(title) {
        // Task 25: Minimal sanitization (Permissive)
        // Only replace characters strictly forbidden by Windows/Linux filesystems
        // < > : " / \ | ? * and control characters
        const badChars = /[<>:"/\\|?*\x00-\x1f]/g;

        let sanitized = title.replace(badChars, '_');

        // Strip leading/trailing dots and spaces (Windows hates these)
        sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '');

        if (!sanitized) sanitized = "empty_title";
        return sanitized;
    }

    cleanId(idStr) {
        // Remove whitespace, BOM, and hidden characters
        return String(idStr).replace(/\uFEFF/g, '').replace(/\s/g, '').trim();
    }

    // ===== Google Takeout Data Loading (Language-Agnostic) =====

    async loadGoogleTakeoutData(takeoutFolder) {
        this.playlists = {};

        try {
            // Get all CSV files in the folder
            const files = await window.electronAPI.readDir(takeoutFolder);
            const csvFiles = files.filter(f => f.toLowerCase().endsWith('.csv'));

            if (csvFiles.length === 0) {
                console.log('No CSV files found in takeout folder');
                return this.playlists;
            }

            // --- MATHEMATICA ALGORITHM IMPLEMENTATION ---

            // 1. Separate Main File from Playlist Files based on Column Count
            let mainFile = null;
            let videoFiles = [];

            for (const file of csvFiles) {
                const path = `${takeoutFolder}/${file}`;
                const content = await window.electronAPI.readFile(path);
                if (!content) continue;

                // Simple check: Read first line to count columns
                const { headers, delimiter, cleanContent } = this.detectCSVFormat(content);
                const colCount = headers.length;

                // Video lists strictly have 2 columns (ID, Timestamp), Main list has many
                if (colCount === 2) {
                    videoFiles.push({ name: file, path, content: cleanContent, headers, delimiter });
                } else if (colCount > 2) {
                    // Check for unique Main Index headers (English + Slovenian)
                    if (headers.some(h => ['ID seznama predvajanja', 'Playlist ID', 'ID'].includes(h))) {
                        mainFile = { name: file, path, content: cleanContent, headers, delimiter };
                    }
                }
            }

            if (!mainFile) {
                console.log('[YTBackup] Could not find main playlist file (Checked for >2 columns + ID header).');
                // Return empty object instead of failing, to avoid UI getting stuck
                return this.playlists;
            }

            console.log(`[YTBackup] Main File Found: ${mainFile.name}`);

            // 2. Dynamic Prefix Stripping (Token-based)
            let prefixTokenCount = 0;
            if (videoFiles.length > 0) {
                const splitNames = videoFiles.map(vf => vf.name.replace('.csv', '').split(' '));

                // Find how many starting tokens are identical across ALL files
                let k = 0;
                while (true) {
                    const tokensAtK = splitNames.map(tokens => tokens[k]);
                    // Check if all declared (some files might be shorter) and identical
                    const allExist = tokensAtK.every(t => t !== undefined);
                    if (!allExist) break;

                    const first = tokensAtK[0];
                    const allSame = tokensAtK.every(t => t === first);
                    if (!allSame) break;

                    k++;
                }
                prefixTokenCount = k;
            }

            // Create Clean Names
            videoFiles.forEach(vf => {
                const tokens = vf.name.replace('.csv', '').split(' ');
                // Join tokens from k to end
                vf.cleanName = tokens.slice(prefixTokenCount).join(' ');
            });
            console.log(`[YTBackup] Prefix Tokens Removed: ${prefixTokenCount}`);


            // 3. Scoring Function (Mathematica Logic)
            const nameMatchScore = (plTitle, filename) => {
                // If Title is shorter than Filename, it's definitely not a prefix match (Penalty)
                // Note: Mathematica logic was: If[StringLength[PlN]<StringLength[FN], -StringLength[FN], ...]
                if (plTitle.length < filename.length) {
                    return -filename.length;
                }

                let score = 0;
                // Compare characters up to the length of the filename
                for (let i = 0; i < filename.length; i++) {
                    if (plTitle[i] === filename[i]) {
                        score += 1;
                    } else {
                        score -= 1;
                    }
                }
                return score;
            };

            // 4. Matrix Match & Assignment
            const mainRows = this.parseCSV(mainFile.content, mainFile.delimiter);
            const mainHeaders = mainRows[0] || [];

            // Support English and Slovenian Headers
            const idColIdx = mainHeaders.findIndex(h => ['ID seznama predvajanja', 'Playlist ID', 'ID'].includes(h));
            // "Naslov seznama predvajanja (izvirnik)" is the specific Slovenian header
            const titleColIdx = mainHeaders.findIndex(h => ['Naslov seznama predvajanja (izvirnik)', 'Naslov seznama predvajanja', 'Playlist Title', 'Title'].includes(h));

            if (idColIdx === -1) {
                console.log('[YTBackup] Missing ID column in Main Index.');
                return this.playlists;
            }

            let playlistsCount = 0;

            for (let i = 1; i < mainRows.length; i++) {
                const row = mainRows[i];
                if (!row) continue;

                const plId = this.cleanId(row[idColIdx]);
                if (!plId) continue;

                // Fallback title if column missing or empty
                const plTitle = (titleColIdx !== -1 && row[titleColIdx]) ? row[titleColIdx].trim() : `Playlist ${plId}`;

                // Find Best Match for this Playlist
                let bestFile = null;
                let maxScore = -Infinity;

                videoFiles.forEach(vf => {
                    const score = nameMatchScore(plTitle, vf.cleanName);
                    if (score > maxScore) {
                        maxScore = score;
                        bestFile = vf;
                    }
                });

                // Threshold: Only accept if it's somewhat reasonable (e.g. > -5) or just take best? 
                // Mathematica takes strictly the Max, so we do too.

                if (bestFile) {
                    console.log(`[YTBackup] MATCH: "${plTitle}" -> "${bestFile.cleanName}" (Score: ${maxScore})`);

                    // Parse Video IDs from the chosen file
                    const vRows = this.parseCSV(bestFile.content, bestFile.delimiter);
                    const vHeaders = vRows[0] || [];
                    const vidIdIdx = vHeaders.findIndex(h => ['ID videoposnetka', 'Video ID', 'ID'].includes(h));

                    const videoIds = [];
                    if (vidIdIdx !== -1) {
                        for (let r = 1; r < vRows.length; r++) {
                            const vRow = vRows[r];
                            if (vRow[vidIdIdx]) {
                                const vId = this.cleanId(vRow[vidIdIdx]);
                                if (vId) videoIds.push(vId);
                            }
                        }
                    }

                    this.playlists[plId] = {
                        title: plTitle,
                        video_ids: videoIds,
                        file: bestFile.path
                    };
                    playlistsCount++;
                }
            }

            console.log(`[YTBackup] Finished building playlists. Found: ${playlistsCount}`);
            this.updateProgress(`Loaded ${playlistsCount} playlists`);

        } catch (e) {
            console.error('Error loading Google Takeout data:', e);
            // Ensure we return what we have (or empty) so UI doesn't hang
        }

        return this.playlists;
    }

    detectCSVFormat(content) {
        // Strip BOM from content if present
        const cleanContent = content.replace(/^\uFEFF/, '');
        const firstLine = cleanContent.split('\n')[0] || '';

        // Try different delimiters
        const delimiters = [',', ';', '\t'];
        let bestDelimiter = ',';
        let maxCols = 0;

        for (const delim of delimiters) {
            const cols = firstLine.split(delim).length;
            if (cols > maxCols) {
                maxCols = cols;
                bestDelimiter = delim;
            }
        }

        const headers = this.parseCSVLine(firstLine, bestDelimiter);
        return { headers, delimiter: bestDelimiter, cleanContent };
    }

    // Helper for detecting headers
    parseCSVLine(line, delimiter) {
        const result = [];
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
            } else if (char === delimiter && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result;
    }

    // Robust CSV Parser handling quoted multiline fields
    parseCSV(text, delimiter) {
        const rows = [];
        let currentRow = [];
        let currentField = '';
        let insideQuotes = false;

        // Normalize line endings
        const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        for (let i = 0; i < cleanText.length; i++) {
            const char = cleanText[i];
            const nextChar = cleanText[i + 1];

            if (char === '"') {
                if (insideQuotes && nextChar === '"') {
                    currentField += '"';
                    i++;
                } else {
                    insideQuotes = !insideQuotes;
                }
            } else if (char === delimiter && !insideQuotes) {
                currentRow.push(currentField.trim());
                currentField = '';
            } else if (char === '\n' && !insideQuotes) {
                currentRow.push(currentField.trim());
                if (currentRow.length > 0 && (currentRow.length > 1 || currentRow[0] !== '')) {
                    rows.push(currentRow);
                }
                currentRow = [];
                currentField = '';
            } else {
                currentField += char;
            }
        }

        if (currentField || currentRow.length > 0) {
            currentRow.push(currentField.trim());
            if (currentRow.length > 0 && (currentRow.length > 1 || currentRow[0] !== '')) {
                rows.push(currentRow);
            }
        }

        return rows;
    }

    findCommonPrefix(strings) {
        if (strings.length === 0) return '';
        if (strings.length === 1) return strings[0];

        let prefix = '';
        for (let i = 0; i < strings[0].length; i++) {
            const char = strings[0][i];
            if (strings.every(s => s[i] === char)) {
                prefix += char;
            } else {
                break;
            }
        }
        return prefix;
    }

    // ===== Disk Synchronization =====

    async syncDownloadsWithDisk(audioDir) {
        this.updateProgress('Syncing local files with tracking data...');

        // Task 18, 21 & Format Update: Support broad audio and image formats
        const videoIdPattern = /(?:-|\()([a-zA-Z0-9_-]{11})\)?\.(mp3|wav|flac|m4a|ogg|webm|aac|opus)$/i;
        const thumbIdPattern = /(?:-|\()([a-zA-Z0-9_-]{11})\)?\.(png|jpg|jpeg|webp|bmp)$/i;
        const foundAudioIds = new Set();
        const foundThumbIds = new Set();

        try {
            const files = await window.electronAPI.readDirRecursive(audioDir);
            for (const filePath of files) {
                const match = filePath.match(videoIdPattern);
                if (match) foundAudioIds.add(match[1]);
            }

            // Also check thumbnails
            const outputFolder = audioDir.split('/').slice(0, -1).join('/');
            const thumbnailDir = outputFolder + '/Thumbnails';
            try {
                const thumbFiles = await window.electronAPI.readDirRecursive(thumbnailDir);
                for (const filePath of thumbFiles) {
                    const match = filePath.match(thumbIdPattern);
                    if (match) foundThumbIds.add(match[1]);
                }
            } catch (e) {
                console.warn('[YTBackup] Could not read thumbnail dir during sync:', e);
            }

            let changed = false;

            // FIX: For files that exist on disk with BOTH audio and thumbnail
            // -> Remove from unavailable and manuallyDeleted
            for (const id of foundAudioIds) {
                // If it exists on disk, it's NOT manually deleted anymore
                if (this.manuallyDeleted.has(id)) {
                    this.manuallyDeleted.delete(id);
                    changed = true;
                }

                if (foundThumbIds.has(id)) {
                    // Fully restored
                    if (this.unavailableVideos.has(id)) {
                        this.unavailableVideos.delete(id);
                        changed = true;
                    }
                } else {
                    // Has audio but no thumbnail
                    // Mark as unavailable if missing thumbnail as requested, 
                    // but since audio exists, it won't be re-downloaded
                    if (!this.unavailableVideos.has(id)) {
                        this.unavailableVideos.add(id);
                        changed = true;
                    }
                }
            }

            // Find newly discovered files and add to previousDownloads
            const newlyFound = new Set([...foundAudioIds].filter(id => !this.previousDownloads.has(id)));

            if (newlyFound.size > 0) {
                for (const id of newlyFound) {
                    this.previousDownloads.add(id);
                }
                changed = true;
            }

            if (changed) {
                await this.saveTrackingData(this.previousDownloads, this.previousDownloadsFile);
                await this.saveTrackingData(this.unavailableVideos, this.unavailableVideosFile);
                await this.saveTrackingData(this.manuallyDeleted, this.manuallyDeletedFile);
                this.updateProgress(`Sync complete. Registered ${newlyFound.size} manual files, updated tracking.`);
                console.log(`[YTBackup] Disk Sync Complete. Found ${foundAudioIds.size} total YouTube files, ${newlyFound.size} were new. Checked: ${audioDir}`);
            } else {
                this.updateProgress('Local files are in sync.');
            }

        } catch (e) {
            console.error('Error syncing with disk:', e);
        }
    }

    async checkExistingAudio(videoList, audioDir, thumbnailDir) {
        const videoIdPattern = /(?:-|\()([a-zA-Z0-9_-]{11})\)?\.(mp3|wav|flac|m4a|ogg|webm|aac|opus)$/i;
        const thumbIdPattern = /(?:-|\()([a-zA-Z0-9_-]{11})\)?\.(png|jpg|jpeg|webp|bmp)$/i;
        const existingAudioIds = new Set();
        const existingThumbIds = new Set();

        try {
            const files = await window.electronAPI.readDirRecursive(audioDir);
            for (const filePath of files) {
                const match = filePath.match(videoIdPattern);
                if (match) existingAudioIds.add(match[1]);
            }
        } catch (e) {
            console.error('Error checking existing audio:', e);
        }

        try {
            const thumbFiles = await window.electronAPI.readDirRecursive(thumbnailDir);
            for (const filePath of thumbFiles) {
                const match = filePath.match(thumbIdPattern);
                if (match) existingThumbIds.add(match[1]);
            }
        } catch (e) {
            console.error('Error checking existing thumbnails:', e);
        }

        const result = {};
        for (const videoId of videoList) {
            const hasAudio = existingAudioIds.has(videoId);
            const hasThumb = existingThumbIds.has(videoId);
            result[videoId] = {
                audio_exists: hasAudio && hasThumb,
                has_audio: hasAudio,
                has_thumbnail: hasThumb
            };
        }
        return result;
    }

    async detectManuallyDeletedFiles(audioDir, thumbnailDir) {
        const videoIdPattern = /(?:-|\()([a-zA-Z0-9_-]{11})\)?\.(mp3|wav|flac|m4a|ogg|webm|aac|opus)$/i;
        const thumbIdPattern = /(?:-|\()([a-zA-Z0-9_-]{11})\)?\.(png|jpg|jpeg|webp|bmp)$/i;
        const foundAudioIds = new Set();

        try {
            const files = await window.electronAPI.readDirRecursive(audioDir);
            for (const filePath of files) {
                const match = filePath.match(videoIdPattern);
                if (match) foundAudioIds.add(match[1]);
            }
        } catch (e) {
            console.error('Error scanning audio dir:', e);
        }

        console.log(`[YTBackup] Previous downloads IDs: ${this.previousDownloads.size}`);
        console.log(`[YTBackup] Found files on disk: ${foundAudioIds.size}`);
        if (this.previousDownloads.size > 0 && foundAudioIds.size > 0) {
            const firstId = Array.from(this.previousDownloads)[0];
            console.log(`[YTBackup] Sample ID check: ${firstId} -> found on disk? ${foundAudioIds.has(firstId)}`);
        }
        this.manuallyDeleted = new Set([...this.previousDownloads].filter(id => !foundAudioIds.has(id)));
        console.log(`[YTBackup] Detected ${this.manuallyDeleted.size} manually deleted songs.`);

        // NOTE: Removed automatic thumbnail deletion - program should NEVER delete files

        await this.saveTrackingData(this.manuallyDeleted, this.manuallyDeletedFile);
        return this.manuallyDeleted;
    }

    async downloadVideoAndThumb(videoId, audioDir, thumbnailDir) {
        const info = await window.electronAPI.getVideoInfo(videoId);
        if (!info.success) {
            console.log(`[YTBackup] getVideoInfo FAILED for ${videoId}. Raw error:`, info.error);
            const ageRestricted = this.checkAgeRestriction(videoId, info.error);
            return {
                error: ageRestricted ? 'Age Restricted - cookies.txt required' : 'Video unavailable',
                video_id: videoId,
                raw_error: info.error
            };
        }

        const title = info.title || `Video_${videoId}`;
        const cleanedTitle = this.cleanFilename(title);
        this.currentTitle = cleanedTitle; // Store for progress display

        // Task 19: Report current title IMMEDIATELY so it appears in the progress line while downloading
        if (this.onProgressBar) this.onProgressBar(0, 0, 0, this.currentTitle);

        const baseFilename = `${cleanedTitle}-(${videoId})`;

        const result = { video_id: videoId, audio: false, thumbnail: false, errors: [] };

        this.updateProgress(`Downloading: ${cleanedTitle}`);
        const audioResult = await window.electronAPI.spawnYtDlp(videoId, audioDir, baseFilename);
        result.audio = audioResult.success;
        if (!audioResult.success) result.errors.push(`Audio: ${audioResult.error}`);

        if (result.audio) {
            const thumbResult = await window.electronAPI.downloadThumbnail(videoId, thumbnailDir, baseFilename);
            result.thumbnail = thumbResult.success;
            if (!thumbResult.success) result.errors.push(`Thumbnail: ${thumbResult.error}`);
        }

        return result;
    }

    async renderUnavailableVideos(container, audioDir, thumbnailDir) {
        if (!container) return;

        try {
            // USER REQ: Display = Unavailable MINUS Ignored
            let displayVideos = Array.from(this.unavailableVideos)
                .filter(vid => !this.ignoredVideos.has(vid));

            if (displayVideos.length === 0) {
                container.innerHTML = '<div class="no-unavailable">No unavailable videos tracking.</div>';
                return;
            }

            // Show loading state immediately because file scan might take time
            container.innerHTML = '<div class="loading-state" style="padding:20px; text-align:center; color:#888;">Checking file status...</div>';

            // Get sort mode
            const sortSelect = document.getElementById('unavailableSortSelect');
            const sortBy = sortSelect ? sortSelect.value : 'newest';

            // Check status if we have directories (Red/Orange/Yellow logic)
            const videoStatus = {};
            if (audioDir && thumbnailDir) {
                try {
                    const statusInfo = await this.checkExistingAudio(displayVideos, audioDir, thumbnailDir);
                    for (const vid of displayVideos) {
                        const info = statusInfo[vid];
                        if (!info) {
                            videoStatus[vid] = 'red'; // Should not happen
                            continue;
                        }
                        if (!info.has_audio) {
                            videoStatus[vid] = 'red';
                        } else if (!info.has_thumbnail) {
                            videoStatus[vid] = 'orange';
                        } else {
                            videoStatus[vid] = 'yellow';
                        }
                    }
                } catch (err) {
                    console.error('[YTBackup] Error checking existing audio for status:', err);
                    // Fallback
                    for (const vid of displayVideos) videoStatus[vid] = 'red';
                }
            } else {
                for (const vid of displayVideos) videoStatus[vid] = 'red';
            }

            // Sorting Logic
            displayVideos.sort((a, b) => {
                // Permutation Sorts
                if (['rd_or_ru', 'rd_ru_or', 'or_rd_ru', 'or_ru_rd', 'ru_rd_or', 'ru_or_rd'].includes(sortBy)) {
                    const statusA = videoStatus[a];
                    const statusB = videoStatus[b];
                    if (statusA === statusB) return 0;

                    const order = sortBy.split('_');
                    const map = { 'rd': 'red', 'or': 'orange', 'ru': 'yellow' };

                    const priorityA = order.indexOf(Object.keys(map).find(k => map[k] === statusA));
                    const priorityB = order.indexOf(Object.keys(map).find(k => map[k] === statusB));

                    if (priorityA === -1) return 1;
                    if (priorityB === -1) return -1;

                    return priorityA - priorityB;
                }

                if (sortBy === 'newest') return 0;
                if (sortBy === 'oldest') return 0;
                if (sortBy === 'id') return a.localeCompare(b);

                return 0;
            });

            if (sortBy === 'newest') {
                displayVideos.reverse();
            }

            container.innerHTML = displayVideos.map((vid, index) => {
                const status = videoStatus[vid] || 'red';
                const dotClass = `status-dot status-dot-${status}`;

                return `
                <div class="unavailable-item playlist-item checkbox-item" data-index="${index}" style="display: flex; align-items: center; cursor: pointer;">
                    <input type="checkbox" id="unavailable_${vid}" data-video-id="${vid}" style="margin-right: 8px;">
                    <div class="unavail-thumb">
                        <img src="https://img.youtube.com/vi/${vid}/default.jpg" onerror="this.src='placeholder.png'">
                    </div>
                    <div class="unavail-info" style="display: flex; flex-direction: column; justify-content: center; flex: 1;">
                        <div style="font-weight: bold; color: #e0e0e0; font-size: 11px;">
                            <span class="${dotClass}" title="Status: ${status}"></span> ${vid}
                        </div> 
                    </div>
                    <div class="unavailable-actions" style="display: flex; gap: 5px;">
                        <button class="yt-btn small-btn" data-vid="${vid}" title="Open on YouTube">YT</button>
                        <button class="yt-pl-btn small-btn" data-vid="${vid}" title="Open in containing playlists">YT Pl</button>
                        <button class="wbm-btn small-btn" data-vid="${vid}" title="Open in Wayback Machine">WBM</button>
                    </div>
                </div>`;
            }).join('');

            // Selection Logic (Click to toggle & Shift+Click)
            const items = container.querySelectorAll('.unavailable-item');
            items.forEach((item, index) => {
                const checkbox = item.querySelector('input[type="checkbox"]');

                const syncMaster = () => {
                    const selectAllCb = document.getElementById('selectAllUnavailable');
                    if (selectAllCb) {
                        const allCbs = container.querySelectorAll('.unavailable-item input[type="checkbox"]');
                        const allChecked = allCbs.length > 0 && Array.from(allCbs).every(cb => cb.checked);
                        selectAllCb.checked = allChecked;
                    }
                };

                // Prevent text selection on items
                item.style.userSelect = 'none';

                checkbox.onclick = (e) => {
                    e.stopPropagation();
                    const isChecked = checkbox.checked;

                    if (e.shiftKey && this.lastUnavailableClickIndex !== undefined && this.lastUnavailableClickIndex !== index) {
                        const action = this.lastUnavailableClickAction;
                        const start = Math.min(this.lastUnavailableClickIndex, index);
                        const end = Math.max(this.lastUnavailableClickIndex, index);
                        const allCbs = container.querySelectorAll('.unavailable-item input[type="checkbox"]');
                        for (let i = start; i <= end; i++) {
                            allCbs[i].checked = action;
                        }
                        this.lastUnavailableClickIndex = index;
                        syncMaster();
                    } else {
                        this.lastUnavailableClickIndex = index;
                        this.lastUnavailableClickAction = isChecked;
                        syncMaster();
                    }
                };

                item.onclick = (e) => {
                    if (e.target.closest('button')) return;
                    checkbox.dispatchEvent(new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        shiftKey: e.shiftKey
                    }));
                };
            });

            // Button Event Listeners
            container.querySelectorAll('.yt-btn').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    window.electronAPI.openExternal(`https://www.youtube.com/watch?v=${btn.dataset.vid}`);
                };
            });
            container.querySelectorAll('.open-p-btn').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    this.findAndOpenInPlaylists(btn.dataset.vid);
                };
            });
            container.querySelectorAll('.wbm-btn').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    window.electronAPI.openExternal(`https://web.archive.org/web/https://www.youtube.com/watch?v=${btn.dataset.vid}`);
                };
            });
        } catch (e) {
            console.error('[YTBackup] Render error:', e);
            container.innerHTML = `<div class="error">Render Error: ${e.message}</div>`;
        }
    }

    async removeUnavailableEntry(videoId) {
        this.unavailableVideos.delete(videoId);
    }

    async ignoreVideos(videoIds) {
        for (const id of videoIds) this.ignoredVideos.add(id);
        await this.saveTrackingData(this.ignoredVideos, this.ignoredVideosFile);
    }

    async findAndOpenInPlaylists(videoId) {
        let foundCount = 0;
        console.log(`[YTBackup] Searching for video ${videoId} in playlists...`);

        for (const plId in this.playlists) {
            const pl = this.playlists[plId];
            if (!pl.video_ids) continue;

            const indices = [];
            for (let i = 0; i < pl.video_ids.length; i++) {
                if (pl.video_ids[i] === videoId) indices.push(i);
            }

            if (indices.length === 0) continue;

            // For each occurrence of the video in this playlist
            for (const originalIndex of indices) {
                foundCount++;

                let targetVid = videoId;
                let targetIndex = originalIndex;
                let isAvailable = !this.unavailableVideos.has(videoId);

                if (!isAvailable) {
                    // Search BACKWARD for nearest available
                    let foundBackward = false;
                    for (let i = originalIndex - 1; i >= 0; i--) {
                        if (!this.unavailableVideos.has(pl.video_ids[i])) {
                            targetVid = pl.video_ids[i];
                            targetIndex = i;
                            foundBackward = true;
                            break;
                        }
                    }

                    // If not found backward, search FORWARD
                    if (!foundBackward) {
                        for (let i = originalIndex + 1; i < pl.video_ids.length; i++) {
                            if (!this.unavailableVideos.has(pl.video_ids[i])) {
                                targetVid = pl.video_ids[i];
                                targetIndex = i;
                                break;
                            }
                        }
                    }
                }

                // Construct URL. index is 1-based but index param can be finicky, 
                // using watch?v=ID&list=LIST is most reliable for context.
                // We add index= as a hint.
                const url = `https://www.youtube.com/watch?v=${targetVid}&list=${plId}`;
                console.log(`[YTBackup] Opening playlist ${pl.title}. Target: ${targetVid} (Original: ${videoId})`);
                window.electronAPI.openExternal(url);
            }
        }

        if (foundCount === 0) alert('Video not found in any currently loaded local playlist backup.');
    }

    async generatePlaylistData(selectedPlaylists, audioDir) {
        console.log('[YTBackup] Generating simplified playlist data...');
        const playlistData = {};
        for (const plId in selectedPlaylists) {
            playlistData[plId] = {
                title: selectedPlaylists[plId].title,
                video_ids: selectedPlaylists[plId].video_ids
            };
        }
        await window.electronAPI.writeFile(this.playlistDataFile, JSON.stringify(playlistData, null, 2));
        this.updateProgress('Finished: Playlist data generated', 100);
        return playlistData;
    }

    async startDownload(selectedPlaylists, outputFolder, isRetry = false) {
        const audioDir = `${outputFolder}/Audio`;
        const thumbnailDir = `${outputFolder}/Thumbnails`;
        this.downloadedInSession = 0; // Reset session count at start

        let completed = 0;
        let failed = 0;
        let skipped = 0;

        try {
            if (!isRetry) {
                await this.syncDownloadsWithDisk(audioDir);
                this.updateProgress('Checking for manually deleted files...');
                await this.detectManuallyDeletedFiles(audioDir, thumbnailDir);
            }

            const allVideoIds = new Set();
            if (Array.isArray(selectedPlaylists)) {
                selectedPlaylists.forEach(vid => allVideoIds.add(vid));
            } else {
                for (const plId in selectedPlaylists) {
                    for (const vid of selectedPlaylists[plId].video_ids) allVideoIds.add(vid);
                }
            }

            this.updateProgress('Checking existing files...');
            const existingInfo = await this.checkExistingAudio([...allVideoIds], audioDir, thumbnailDir);

            const toDownload = [];
            for (const vid of allVideoIds) {
                if (!isRetry && this.unavailableVideos.has(vid)) {
                    skipped++;
                    continue;
                }
                // SKIP manually deleted files during main download
                if (!isRetry && this.manuallyDeleted.has(vid)) {
                    skipped++;
                    continue;
                }

                const info = existingInfo[vid];

                // FIX: Force download on retry, ignoring partial existence
                if (isRetry) {
                    toDownload.push(vid);
                    continue;
                }

                // FIX: Only download if we don't have the AUDIO. 
                // Missing thumbnails alone shouldn't trigger a re-download in the main loop.
                if (!info.has_audio && !info.skip_reason) {
                    toDownload.push(vid);
                } else {
                    skipped++;
                }
            }

            this.updateProgress(`Need to download ${toDownload.length} songs (${skipped} exist/skipped)`);

            // Early return if nothing to download - prevents stuck button
            if (toDownload.length === 0) {
                this.updateProgress(`All songs already downloaded or skipped (${skipped} total).`);
                if (!isRetry && !Array.isArray(selectedPlaylists)) {
                    await this.generatePlaylistData(selectedPlaylists, audioDir);
                }
                return { completed: 0, failed: 0, skipped };
            }

            for (let i = 0; i < toDownload.length; i++) {
                // Check session limit
                const maxDls = parseInt(document.getElementById('maxDownloads')?.value || 1000);
                if (this.downloadedInSession >= maxDls) {
                    this.updateProgress(`Stopping: Session limit of ${maxDls} downloads reached.`);
                    break;
                }

                const vid = toDownload[i];
                const isRestoring = this.manuallyDeleted.has(vid);

                // Report current title *before* download starts so it appears in the progress line immediately
                if (this.onProgressBar) this.onProgressBar(completed, failed, toDownload.length, this.currentTitle || "Fetching info...");

                const result = await this.downloadVideoAndThumb(vid, audioDir, thumbnailDir);

                if (result.audio && result.thumbnail) {
                    completed++;
                    this.downloadedInSession++; // Increment session count
                    this.previousDownloads.add(vid);
                    if (isRestoring) this.manuallyDeleted.delete(vid);
                    if (isRetry) this.unavailableVideos.delete(vid);
                } else {
                    failed++;
                    if (isRestoring) {
                        this.previousDownloads.delete(vid);
                        this.manuallyDeleted.delete(vid);
                        this.unavailableVideos.add(vid);
                    } else if (!isRetry) {
                        this.unavailableVideos.add(vid);
                    }
                }

                this.updateProgress(`Progress: ${completed + failed}/${toDownload.length} (Success: ${completed}, Failed: ${failed})`);
                // Clear currentTitle after reporting so it doesn't linger for the next song before it starts
                if (this.onProgressBar) this.onProgressBar(completed, failed, toDownload.length, this.currentTitle);
                this.currentTitle = "";

                const delay = parseFloat(this.settings.delay_between_downloads || 2);
                if (delay > 0 && i < toDownload.length - 1) await new Promise(r => setTimeout(r, delay * 1000));
            }

            await this.saveTrackingData(this.previousDownloads, this.previousDownloadsFile);
            await this.saveTrackingData(this.manuallyDeleted, this.manuallyDeletedFile);
            await this.saveTrackingData(this.unavailableVideos, this.unavailableVideosFile);
            await this.saveTrackingData(this.ignoredVideos, this.ignoredVideosFile);

            if (!isRetry && !Array.isArray(selectedPlaylists)) {
                await this.generatePlaylistData(selectedPlaylists, audioDir);
            }

            return { completed, failed, skipped };
        } catch (e) {
            console.error('Download error:', e);
            return { completed, failed, skipped, error: e.message };
        }
    }

    showCookieModal(videoId) {
        const modal = document.getElementById('cookieModal');
        if (modal) {
            modal.style.display = 'flex'; // Centered (via flex in CSS)
            console.log(`[YTBackup] Triggered Cookie Assistant for ${videoId}`);

            // Update links to correct extensions
            const chromeLink = document.getElementById('chromeExtLink');
            const firefoxLink = document.getElementById('firefoxExtLink');
            if (chromeLink) chromeLink.href = 'https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc';
            if (firefoxLink) firefoxLink.href = 'https://addons.mozilla.org/en-US/firefox/addon/get-cookies-txt-locally/';

            // Listen for upload completion to auto-resume
            const onUpload = () => {
                modal.style.display = 'none';
                this.resume();
                window.removeEventListener('cookies-uploaded', onUpload);
            };
            window.addEventListener('cookies-uploaded', onUpload);
        }
    }

    async renderDeletedVideos(container, audioDir, thumbnailDir) {
        if (!container) return;
        try {
            let displayVideos = Array.from(this.manuallyDeleted);
            if (displayVideos.length === 0) {
                container.innerHTML = '<div class="no-unavailable">No manually deleted videos tracking.</div>';
                return;
            }
            container.innerHTML = '<div class="loading-state" style="padding:20px; text-align:center; color:#888;">Checking file status...</div>';
            const sortSelect = document.getElementById('deletedSortSelect');
            const sortBy = sortSelect ? sortSelect.value : 'newest';
            const videoStatus = {};
            if (audioDir && thumbnailDir) {
                const statusInfo = await this.checkExistingAudio(displayVideos, audioDir, thumbnailDir);
                for (const vid of displayVideos) {
                    const info = statusInfo[vid];
                    // Red = both missing or no info, Orange = has thumbnail but no audio
                    if (!info) { videoStatus[vid] = 'red'; continue; }
                    if (!info.has_audio && !info.has_thumbnail) videoStatus[vid] = 'red';
                    else if (!info.has_audio && info.has_thumbnail) videoStatus[vid] = 'orange';
                    else videoStatus[vid] = 'red'; // Fallback
                }
            } else {
                for (const vid of displayVideos) videoStatus[vid] = 'red';
            }
            displayVideos.sort((a, b) => {
                if (['rd_or', 'or_rd'].includes(sortBy)) {
                    const order = sortBy.split('_'); const map = { 'rd': 'red', 'or': 'orange' };
                    const priorityA = order.indexOf(Object.keys(map).find(k => map[k] === videoStatus[a]));
                    const priorityB = order.indexOf(Object.keys(map).find(k => map[k] === videoStatus[b]));
                    return priorityA - priorityB;
                }
                if (sortBy === 'id') return a.localeCompare(b);
                return 0;
            });
            if (sortBy === 'newest') displayVideos.reverse();
            container.innerHTML = displayVideos.map((vid, index) => {
                const status = videoStatus[vid] || 'red';
                const dotClass = `status-dot status-dot-${status}`;
                return `
                <div class="deleted-item playlist-item checkbox-item" data-index="${index}" style="display: flex; align-items: center; cursor: pointer;">
                    <input type="checkbox" id="deleted_${vid}" data-video-id="${vid}" style="margin-right: 8px;">
                    <div class="unavail-thumb"><img src="https://img.youtube.com/vi/${vid}/default.jpg" onerror="this.src='placeholder.png'"></div>
                    <div class="unavail-info" style="display: flex; flex-direction: column; justify-content: center; flex: 1;">
                        <div style="font-weight: bold; color: #e0e0e0; font-size: 11px;"><span class="${dotClass}" title="Status: ${status}"></span> ${vid}</div>
                    </div>
                    <div class="deleted-actions" style="display: flex; gap: 5px;">
                        <button class="yt-btn small-btn" data-vid="${vid}" title="Open on YouTube">YT</button>
                        <button class="yt-pl-btn small-btn" data-vid="${vid}" title="Open in containing playlists">YT Pl</button>
                        <button class="wbm-btn small-btn" data-vid="${vid}" title="Open in Wayback Machine">WBM</button>
                    </div>
                </div>`;
            }).join('');
            const items = container.querySelectorAll('.deleted-item');
            items.forEach((item, index) => {
                const checkbox = item.querySelector('input[type="checkbox"]');

                // Prevent text selection
                item.style.userSelect = 'none';

                checkbox.onclick = (e) => {
                    e.stopPropagation();
                    const isChecked = checkbox.checked;

                    if (e.shiftKey && this.lastDeletedClickIndex !== undefined && this.lastDeletedClickIndex !== index) {
                        const action = this.lastDeletedClickAction;
                        const start = Math.min(this.lastDeletedClickIndex, index);
                        const end = Math.max(this.lastDeletedClickIndex, index);
                        const allCbs = container.querySelectorAll('.deleted-item input[type="checkbox"]');
                        for (let i = start; i <= end; i++) {
                            allCbs[i].checked = action;
                        }
                        this.lastDeletedClickIndex = index;
                        this.syncDeletedMaster();
                    } else {
                        this.lastDeletedClickIndex = index;
                        this.lastDeletedClickAction = isChecked;
                        this.syncDeletedMaster();
                    }
                };

                item.onclick = (e) => {
                    if (e.target.closest('button')) return;
                    checkbox.dispatchEvent(new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        shiftKey: e.shiftKey
                    }));
                };
            });
            container.querySelectorAll('.yt-btn').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); window.electronAPI.openExternal(`https://www.youtube.com/watch?v=${btn.dataset.vid}`); });
            container.querySelectorAll('.yt-pl-btn').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); this.findAndOpenInPlaylists(btn.dataset.vid); });
            container.querySelectorAll('.wbm-btn').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); window.electronAPI.openExternal(`https://web.archive.org/web/https://www.youtube.com/watch?v=${btn.dataset.vid}`); });
        } catch (e) { console.error('[YTBackup] Render error:', e); container.innerHTML = `<div class="error">Render Error: ${e.message}</div>`; }
    }

    syncDeletedMaster() {
        const selectAllCb = document.getElementById('selectAllDeleted');
        if (selectAllCb) {
            const allCbs = document.querySelectorAll('#deletedList .deleted-item input[type="checkbox"]');
            selectAllCb.checked = allCbs.length > 0 && Array.from(allCbs).every(cb => cb.checked);
        }
    }

    updateProgress(message, percentage = -1) {
        console.log('[YTBackup]', message);
        if (this.onProgress) {
            let status = "Working...";
            let itemName = message;
            if (message.startsWith("Downloading:")) {
                status = "Downloading";
                itemName = message.replace("Downloading:", "").trim();
            } else if (message.startsWith("Syncing")) {
                status = "Syncing";
            }
            // Pass empty string for raw message to suppress bottom text update
            this.onProgress({ status, itemName, percentage, raw: "" });
        }
    }
    checkAgeRestriction(videoId, rawErrorMsg) {
        const rawError = (rawErrorMsg || '').toLowerCase();
        const ageKeywords = [
            'confirm your age',
            'age-restricted',
            'sign in to confirm your age',
            'sign in to youtube',
            'login required'
        ];

        const isAgeRestricted = ageKeywords.some(kw => rawError.includes(kw));

        if (isAgeRestricted) {
            console.warn(`[YTBackup] CRITICAL: Age restriction detected for ${videoId}. Opening modal...`);
            this.showCookieModal(videoId);
            this.pause();
        }
        return isAgeRestricted;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = YTBackup;
}
