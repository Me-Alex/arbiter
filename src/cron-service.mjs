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
 * Adapt any injected logger to a `{ info, warn, error }` object.
 *
 * The app injects `logger(level, msg)` — a plain function — from both
 * server.mjs, while this service (and console) is
 * used method-style as `logger.info(...)`. Callers may also pass a bare
 * function with no level argument, which we treat as `info`. Normalising
 * once here keeps every call site below free of defensive `typeof` checks.
 */
function normalizeLogger(candidate) {
  // Already a method-style logger — keep it as-is so a caller that compares by
  // reference (or keeps its own state) sees exactly the object it injected.
  // `warn` is required too: start()/stop() call it unguarded, so passing
  // through an object with only .info/.error threw a TypeError on the first
  // duplicate-start call.
  if (candidate && typeof candidate === 'object'
      && typeof candidate.info === 'function'
      && typeof candidate.warn === 'function'
      && typeof candidate.error === 'function') {
    return candidate;
  }
  const emit = typeof candidate === 'function'
    ? (level, msg) => candidate(level, msg)
    : null;
  const sink = candidate && typeof candidate === 'object' ? candidate : console;
  const call = (level, args) => {
    const text = args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    if (emit) return emit(level, text);
    const fn = typeof sink[level] === 'function' ? sink[level] : sink.log;
    if (typeof fn === 'function') fn.call(sink, text);
  };
  return {
    info: (...args) => call('info', args),
    warn: (...args) => call('warn', args),
    error: (...args) => call('error', args),
  };
}

/**
 * Cron Service - Manages scheduled cleanup tasks
 */
export class CronService {
  constructor(options = {}) {
    this.logger = normalizeLogger(options.logger);
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
      this.logger.warn('Cron service already running');
      return;
    }

    this.running = true;
    this.logger.info('Starting cron service...');

    // Don't start actual timers in test mode
    if (this.testMode) {
      this.logger.info('Cron service in test mode, skipping actual timers');
      return;
    }

    // Start regular cleanup (every 6 hours)
    this.startRegularCleanup();

    // Start full cleanup (daily at 2 AM)
    this.startFullCleanup();

    // Start log rotation (every hour)
    this.startLogRotation();

    this.logger.info('Cron service started');
  }

  /**
   * Stop all scheduled tasks
   */
  stop() {
    if (!this.running) {
      this.logger.warn('Cron service not running');
      return;
    }

    this.logger.info('Stopping cron service...');
    
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
    this.logger.info(`Next regular cleanup scheduled in ${this.config.cleanupIntervalHours} hours`);
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
    
    this.logger.info(`Next full cleanup scheduled for ${nextRun.toISOString()}`);
    
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
    this.logger.info(`Next full cleanup scheduled for ${nextRun.toISOString()}`);
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
    this.logger.info(`Next log rotation scheduled in ${this.config.logRotationIntervalHours} hours`);
  }

  /**
   * Run cleanup immediately
   */
  async runCleanupNow(options = {}) {
    this.logger.info('Running cleanup on demand...');
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
