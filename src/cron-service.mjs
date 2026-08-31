/**
 * cron-service.mjs — Scheduled cleanup and maintenance tasks
 * Manages periodic cleanup of staging files, logs, backups, etc.
 */

import { setTimeout as setTimeoutCallback } from 'node:timers';
import { runCleanup } from '../scripts/cleanup.mjs';

// Cleanup schedule configuration
const CRON_CONFIG = {
  // Run cleanup every 6 hours
  cleanupIntervalHours: 6,
  // Run full cleanup (including backups) every day at 2 AM
  fullCleanupHour: 2,
  // Run log rotation every hour
  logRotationIntervalHours: 1,
};

/**
 * Cron Service - Manages scheduled cleanup tasks
 */
export class CronService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.running = false;
    this.timers = new Map();
    this.config = { ...CRON_CONFIG, ...options.config };
    this.testMode = options.testMode || false;
  }

  /**
   * Start all scheduled tasks
   */
  start() {
    if (this.running) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn('Cron service already running');
      }
      return;
    }

    this.running = true;
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info('Starting cron service...');
    }

    // Don't start actual timers in test mode
    if (this.testMode) {
      if (this.logger && typeof this.logger.info === 'function') {
        this.logger.info('Cron service in test mode, skipping actual timers');
      }
      return;
    }

    // Start regular cleanup (every 6 hours)
    this.startRegularCleanup();

    // Start full cleanup (daily at 2 AM)
    this.startFullCleanup();

    // Start log rotation (every hour)
    this.startLogRotation();

    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info('Cron service started');
    }
  }

  /**
   * Stop all scheduled tasks
   */
  stop() {
    if (!this.running) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn('Cron service not running');
      }
      return;
    }

    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info('Stopping cron service...');
    }
    
    // Clear all timers
    for (const [name, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(name);
    }

    this.running = false;
    this.logger.info('Cron service stopped');
  }

  /**
   * Start regular cleanup (staging files, temp files, workspace)
   */
  startRegularCleanup() {
    const runCleanupTask = async () => {
      try {
        this.logger.info('Running regular cleanup...');
        const results = await runCleanup({
          staging: true,
          temp: true,
          workspace: true,
          logs: false, // Handled separately
          backups: false, // Handled in full cleanup
        });
        this.logger.info('Regular cleanup completed:', results);
      } catch (error) {
        this.logger.error('Regular cleanup failed:', error);
      } finally {
        // Schedule next run
        this.scheduleNextCleanup();
      }
    };

    // Run immediately on start
    runCleanupTask();
  }

  /**
   * Schedule next regular cleanup
   */
  scheduleNextCleanup() {
    const intervalMs = this.config.cleanupIntervalHours * 60 * 60 * 1000;
    
    const timer = setTimeoutCallback(() => {
      this.timers.delete('regular-cleanup');
      this.startRegularCleanup();
    }, intervalMs);

    this.timers.set('regular-cleanup', timer);
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(`Next regular cleanup scheduled in ${this.config.cleanupIntervalHours} hours`);
    }
  }

  /**
   * Start full cleanup (including backups)
   */
  startFullCleanup() {
    const runFullCleanupTask = async () => {
      try {
        this.logger.info('Running full cleanup...');
        const results = await runCleanup({
          staging: true,
          temp: true,
          workspace: true,
          logs: true,
          backups: true,
        });
        this.logger.info('Full cleanup completed:', results);
      } catch (error) {
        this.logger.error('Full cleanup failed:', error);
      } finally {
        // Schedule next run
        this.scheduleNextFullCleanup();
      }
    };

    // Calculate time until next 2 AM
    const now = new Date();
    const nextRun = new Date();
    nextRun.setHours(this.config.fullCleanupHour, 0, 0, 0);
    
    if (nextRun <= now) {
      // Already passed today's 2 AM, schedule for tomorrow
      nextRun.setDate(nextRun.getDate() + 1);
    }

    const delayMs = nextRun - now;
    
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(`Next full cleanup scheduled for ${nextRun.toISOString()}`);
    }
    
    const timer = setTimeout(() => {
      this.timers.delete('full-cleanup');
      runFullCleanupTask();
    }, delayMs);

    this.timers.set('full-cleanup', timer);
  }

  /**
   * Schedule next full cleanup
   */
  scheduleNextFullCleanup() {
    const nextRun = new Date();
    nextRun.setDate(nextRun.getDate() + 1);
    nextRun.setHours(this.config.fullCleanupHour, 0, 0, 0);
    
    const delayMs = nextRun - new Date();
    
    const timer = setTimeout(() => {
      this.timers.delete('full-cleanup');
      this.startFullCleanup();
    }, delayMs);

    this.timers.set('full-cleanup', timer);
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(`Next full cleanup scheduled for ${nextRun.toISOString()}`);
    }
  }

  /**
   * Start log rotation
   */
  startLogRotation() {
    const runLogRotation = async () => {
      try {
        this.logger.info('Running log rotation...');
        const results = await runCleanup({
          staging: false,
          temp: false,
          workspace: false,
          logs: true,
          backups: false,
        });
        this.logger.info('Log rotation completed:', results);
      } catch (error) {
        this.logger.error('Log rotation failed:', error);
      } finally {
        // Schedule next run
        this.scheduleNextLogRotation();
      }
    };

    // Run immediately on start
    runLogRotation();
  }

  /**
   * Schedule next log rotation
   */
  scheduleNextLogRotation() {
    const intervalMs = this.config.logRotationIntervalHours * 60 * 60 * 1000;
    
    const timer = setTimeout(() => {
      this.timers.delete('log-rotation');
      this.startLogRotation();
    }, intervalMs);

    this.timers.set('log-rotation', timer);
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(`Next log rotation scheduled in ${this.config.logRotationIntervalHours} hours`);
    }
  }

  /**
   * Run cleanup immediately
   */
  async runCleanupNow(options = {}) {
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info('Running cleanup on demand...');
    }
    return await runCleanup({ ...options, verbose: true });
  }

  /**
   * Get status of cron service
   */
  status() {
    return {
      running: this.running,
      timers: Array.from(this.timers.keys()),
      config: this.config,
    };
  }
}

/**
 * Create cron service instance
 */
export function createCronService(options = {}) {
  return new CronService(options);
}
