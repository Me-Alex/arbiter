/**
 * cron-service.test.mjs — Tests for the cron service
 */

import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CronService } from '../src/cron-service.mjs';

describe('CronService', () => {
  let cronService;
  let mockLogger;

  before(() => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  });

  after(() => {
    if (cronService && cronService.running) {
      cronService.stop();
    }
  });

  describe('Initialization', () => {
    it('should create a new CronService instance', () => {
      cronService = new CronService({ logger: mockLogger });
      assert.ok(cronService instanceof CronService);
      assert.strictEqual(cronService.running, false);
    });

    it('should create a cron service with custom config', () => {
      const customConfig = {
        cleanupIntervalHours: 12,
        fullCleanupHour: 3,
        logRotationIntervalHours: 2,
      };
      cronService = new CronService({ logger: mockLogger, config: customConfig });
      assert.strictEqual(cronService.config.cleanupIntervalHours, 12);
      assert.strictEqual(cronService.config.fullCleanupHour, 3);
      assert.strictEqual(cronService.config.logRotationIntervalHours, 2);
    });
  });

  describe('Start/Stop', () => {
    it('should start the cron service', () => {
      cronService = new CronService({ logger: mockLogger, testMode: true });
      cronService.start();
      assert.strictEqual(cronService.running, true);
      assert.strictEqual(cronService.timers.size, 0); // No timers in test mode
    });

    it('should not start if already running', () => {
      cronService = new CronService({ logger: mockLogger, testMode: true });
      cronService.start();
      const initialTimerCount = cronService.timers.size;
      cronService.start(); // Try to start again
      assert.strictEqual(cronService.timers.size, initialTimerCount);
    });

    it('should stop the cron service', () => {
      cronService = new CronService({ logger: mockLogger, testMode: true });
      cronService.start();
      assert.strictEqual(cronService.running, true);
      
      cronService.stop();
      assert.strictEqual(cronService.running, false);
      assert.strictEqual(cronService.timers.size, 0);
    });

    it('should not stop if not running', () => {
      cronService = new CronService({ logger: mockLogger });
      cronService.stop(); // Should not throw
      assert.strictEqual(cronService.running, false);
    });
  });

  describe('Status', () => {
    it('should return status information', () => {
      cronService = new CronService({ logger: mockLogger });
      const status = cronService.status();
      
      assert.ok('running' in status);
      assert.ok('timers' in status);
      assert.ok('config' in status);
      assert.strictEqual(status.running, false);
      assert.ok(Array.isArray(status.timers));
    });

    it('should return updated status when running', () => {
      cronService = new CronService({ logger: mockLogger, testMode: true });
      cronService.start();
      const status = cronService.status();
      
      assert.strictEqual(status.running, true);
      assert.strictEqual(status.timers.length, 0); // No timers in test mode
    });
  });

  describe('Cleanup Integration', () => {
    it('should have runCleanupNow method', () => {
      cronService = new CronService({ logger: mockLogger, testMode: true });
      assert.strictEqual(typeof cronService.runCleanupNow, 'function');
    });

    it('should run cleanup when called', async () => {
      cronService = new CronService({ logger: mockLogger, testMode: true });
      const result = await cronService.runCleanupNow({
        staging: false,
        logs: false,
        backups: false,
        temp: false,
        workspace: false,
      });
      
      assert.ok(result);
      assert.strictEqual(typeof result, 'object');
    });
  });
});

describe('CronService Configuration', () => {
  it('should have default configuration values', () => {
    const cronService = new CronService({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
    
    assert.strictEqual(cronService.config.cleanupIntervalHours, 6);
    assert.strictEqual(cronService.config.fullCleanupHour, 2);
    assert.strictEqual(cronService.config.logRotationIntervalHours, 1);
  });

  it('should allow configuration override', () => {
    const customConfig = {
      cleanupIntervalHours: 24,
      fullCleanupHour: 4,
      logRotationIntervalHours: 6,
    };
    const cronService = new CronService({ 
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      config: customConfig 
    });
    
    assert.strictEqual(cronService.config.cleanupIntervalHours, 24);
    assert.strictEqual(cronService.config.fullCleanupHour, 4);
    assert.strictEqual(cronService.config.logRotationIntervalHours, 6);
  });
});

// This used to be a `createCronService` block, testing a factory that wrapped
// `new CronService(options)` in one line and that nothing but this file called —
// src/server.mjs constructs the class directly. The property is kept and pointed
// at the construction the server actually performs.
describe('construction', () => {
  it('should hand the options to the instance', () => {
    const mockLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const service = new CronService({ logger: mockLogger });
    assert.ok(service instanceof CronService);
    assert.strictEqual(service.logger, mockLogger);
  });
});
