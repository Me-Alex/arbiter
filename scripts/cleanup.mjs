/**
 * cleanup.mjs — Cleanup script for Arbiter
 * Handles staging file cleanup, log rotation, and backup management
 */

import { readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = process.env.ARBITER_DATA_DIR || join(ROOT, 'data');
const LOG_DIR = join(ROOT, 'logs');

// Configuration
const CLEANUP_CONFIG = {
  // Staging files older than this (in hours) will be deleted
  stagingMaxAgeHours: 24,
  // Log files older than this (in days) will be rotated/deleted
  logMaxAgeDays: 30,
  // Maximum number of backup files to keep
  maxBackups: 10,
  // Backup files older than this (in days) will be deleted
  backupMaxAgeDays: 90,
  // Temporary files older than this (in hours) will be deleted
  tempMaxAgeHours: 1,
};

/**
 * Clean up old staging files
 */
async function cleanupStagingFiles() {
  const stagingDir = join(DATA_DIR, 'staging');
  
  try {
    const files = await readdir(stagingDir);
    const now = Date.now();
    const maxAgeMs = CLEANUP_CONFIG.stagingMaxAgeHours * 60 * 60 * 1000;
    
    let deletedCount = 0;
    
    for (const file of files) {
      const filePath = join(stagingDir, file);
      const fileStat = await stat(filePath);
      
      if (now - fileStat.mtimeMs > maxAgeMs) {
        await unlink(filePath);
        console.log(`Deleted old staging file: ${file}`);
        deletedCount++;
      }
    }
    
    console.log(`Cleaned up ${deletedCount} old staging files`);
    return deletedCount;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Staging directory does not exist, skipping cleanup');
      return 0;
    }
    console.error('Error cleaning up staging files:', error);
    throw error;
  }
}

/**
 * Rotate and cleanup old log files
 */
async function cleanupLogs() {
  try {
    const files = await readdir(LOG_DIR);
    const now = Date.now();
    const maxAgeMs = CLEANUP_CONFIG.logMaxAgeDays * 24 * 60 * 60 * 1000;
    
    let deletedCount = 0;
    
    for (const file of files) {
      if (file === 'server.log') continue; // Keep current log
      
      const filePath = join(LOG_DIR, file);
      const fileStat = await stat(filePath);
      
      if (now - fileStat.mtimeMs > maxAgeMs) {
        await unlink(filePath);
        console.log(`Deleted old log file: ${file}`);
        deletedCount++;
      }
    }
    
    console.log(`Cleaned up ${deletedCount} old log files`);
    return deletedCount;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Logs directory does not exist, skipping cleanup');
      return 0;
    }
    console.error('Error cleaning up logs:', error);
    throw error;
  }
}

/**
 * Clean up old backup files
 */
async function cleanupBackups() {
  const backupDir = join(DATA_DIR, 'backups');
  
  try {
    const files = await readdir(backupDir);
    const now = Date.now();
    const maxAgeMs = CLEANUP_CONFIG.backupMaxAgeDays * 24 * 60 * 60 * 1000;
    
    // Sort files by modification time (oldest first)
    const filesWithStats = await Promise.all(
      files.map(async (file) => {
        const filePath = join(backupDir, file);
        const fileStat = await stat(filePath);
        return { file, filePath, mtimeMs: fileStat.mtimeMs };
      })
    );
    
    filesWithStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
    
    let deletedCount = 0;
    
    // Keep only the most recent maxBackups files
    if (filesWithStats.length > CLEANUP_CONFIG.maxBackups) {
      const toDelete = filesWithStats.slice(0, filesWithStats.length - CLEANUP_CONFIG.maxBackups);
      
      for (const { file, filePath } of toDelete) {
        // Also check age
        if (now - filePath.mtimeMs > maxAgeMs) {
          await unlink(filePath);
          console.log(`Deleted old backup file: ${file}`);
          deletedCount++;
        }
      }
    }
    
    // Also delete any files older than maxAgeMs
    for (const { file, filePath, mtimeMs } of filesWithStats) {
      if (now - mtimeMs > maxAgeMs) {
        await unlink(filePath);
        console.log(`Deleted old backup file (age): ${file}`);
        deletedCount++;
      }
    }
    
    console.log(`Cleaned up ${deletedCount} old backup files`);
    return deletedCount;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Backups directory does not exist, skipping cleanup');
      return 0;
    }
    console.error('Error cleaning up backups:', error);
    throw error;
  }
}

/**
 * Clean up temporary files
 */
async function cleanupTempFiles() {
  const tempDirs = [
    join(DATA_DIR, 'temp'),
    join(DATA_DIR, 'tmp'),
  ];
  
  let totalDeleted = 0;
  
  for (const tempDir of tempDirs) {
    try {
      const files = await readdir(tempDir);
      const now = Date.now();
      const maxAgeMs = CLEANUP_CONFIG.tempMaxAgeHours * 60 * 60 * 1000;
      
      for (const file of files) {
        const filePath = join(tempDir, file);
        const fileStat = await stat(filePath);
        
        if (now - fileStat.mtimeMs > maxAgeMs) {
          await unlink(filePath);
          console.log(`Deleted old temp file: ${file}`);
          totalDeleted++;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Error cleaning up temp directory ${tempDir}:`, error);
      }
    }
  }
  
  console.log(`Cleaned up ${totalDeleted} old temporary files`);
  return totalDeleted;
}

/**
 * Clean up old workspace files (except latest ones)
 */
async function cleanupWorkspace() {
  const workspaceDir = join(DATA_DIR, 'workspace');
  
  try {
    const files = await readdir(workspaceDir);
    const now = Date.now();
    
    // Keep files that are actively being used (recently modified)
    const recentThresholdMs = 1 * 60 * 60 * 1000; // 1 hour
    
    let deletedCount = 0;
    
    for (const file of files) {
      // Don't delete latest-*.json files
      if (file.startsWith('latest-')) continue;
      
      const filePath = join(workspaceDir, file);
      
      try {
        const fileStat = await stat(filePath);
        
        // Delete if older than 1 hour and not a latest file
        if (now - fileStat.mtimeMs > recentThresholdMs) {
          await unlink(filePath);
          console.log(`Deleted old workspace file: ${file}`);
          deletedCount++;
        }
      } catch (error) {
        // File might be locked or already deleted, skip it
        console.warn(`Could not delete workspace file ${file}:`, error.message);
      }
    }
    
    console.log(`Cleaned up ${deletedCount} old workspace files`);
    return deletedCount;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Workspace directory does not exist, skipping cleanup');
      return 0;
    }
    console.error('Error cleaning up workspace:', error);
    throw error;
  }
}

/**
 * Main cleanup function
 */
export async function runCleanup(options = {}) {
  const {
    staging = true,
    logs = true,
    backups = true,
    temp = true,
    workspace = true,
  } = options;
  
  console.log('Starting Arbiter cleanup...');
  
  const results = {};
  
  if (staging) {
    results.staging = await cleanupStagingFiles();
  }
  
  if (logs) {
    results.logs = await cleanupLogs();
  }
  
  if (backups) {
    results.backups = await cleanupBackups();
  }
  
  if (temp) {
    results.temp = await cleanupTempFiles();
  }
  
  if (workspace) {
    results.workspace = await cleanupWorkspace();
  }
  
  const totalCleaned = Object.values(results).reduce((sum, count) => sum + (count || 0), 0);
  console.log(`Cleanup complete. Total files removed: ${totalCleaned}`);
  
  return results;
}

/**
 * Run cleanup as a standalone script
 */
if (process.argv[1]?.includes('cleanup.mjs')) {
  runCleanup({ verbose: true })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Cleanup failed:', error);
      process.exit(1);
    });
}

export { cleanupStagingFiles, cleanupLogs, cleanupBackups, cleanupTempFiles, cleanupWorkspace, CLEANUP_CONFIG };
