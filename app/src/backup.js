import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// Backup and restore for the local-only store: there's no server copy of this data, so a lost
// or wiped phone loses it for good unless the household has exported one of these first.

const LOCAL_KEY = 'milkledger.v1';

function backupFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `milk-ledger-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** Share the household's full records as a JSON file it can save anywhere (Drive, email, Files). */
export async function exportBackup() {
  const data = localStorage.getItem(LOCAL_KEY);
  if (!data) throw new Error('There is nothing to back up yet.');
  const filename = backupFilename();

  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: 'Milk Ledger backup', url: uri });
  } else {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

/** Replace everything on this device with a previously exported backup file. */
export async function restoreBackup(file) {
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.deliveries)) {
    throw new Error("That file doesn't look like a Milk Ledger backup.");
  }
  localStorage.setItem(LOCAL_KEY, text);
}
