const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'Config.json');
const backupPath = path.join(__dirname, 'Config.json.bak');

if (!fs.existsSync(configPath)) {
    console.error('Config.json not found!');
    process.exit(1);
}

// Backup
fs.copyFileSync(configPath, backupPath);
console.log('Backup created at Config.json.bak');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
let changed = false;

// Matches filenames ending with "-(ID).ext"
// Captures the 11-char ID
const idRegex = /-\(([a-zA-Z0-9_-]{11})\)\.(mp3|wav|flac|m4a|ogg|webm|aac|opus)$/i;

function migrateObject(objName) {
    if (!config[objName]) return;

    const oldObj = config[objName];
    const newObj = {};
    let count = 0;
    let total = 0;

    for (const key in oldObj) {
        total++;
        const match = key.match(idRegex);
        if (match) {
            const id = match[1];
            // If the key is ALREADY just an ID (11 chars), keep it.
            // But here we are iterating keys that are presumably filenames.
            // If a key is ALREADY an ID, it won't match the regex (no extension).

            newObj[id] = oldObj[key];
            count++;
        } else {
            // Keep original key (full filename or already an ID)
            newObj[key] = oldObj[key];
        }
    }
    config[objName] = newObj;
    console.log(`Migrated ${count}/${total} keys in ${objName}`);
    if (count > 0) changed = true;
}

migrateObject('songDurations');
migrateObject('songPeaks');

if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('Config.json updated successfully.');
} else {
    console.log('No changes needed.');
}
