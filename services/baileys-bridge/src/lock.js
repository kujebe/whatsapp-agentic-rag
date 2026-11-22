const crypto = require('crypto');

/**
 * Distributed Redis Single-Instance Lock Manager.
 * Uses atomic Lua scripts for renewal and safe release.
 */
class RedisSessionLock {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.tenantId = options.tenantId || process.env.TENANT_ID || 'default';
    this.lockKey = `whatsapp:${this.tenantId}:session:lock`;
    this.instanceId = options.instanceId || crypto.randomUUID();
    this.ttlMs = options.ttlMs || 10000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 3500;
    this.heartbeatTimer = null;
    this.logger = options.logger || console;
    this.isOwner = false;

    // Predefine atomic Lua scripts
    this.renewLua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    this.releaseLua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
  }

  /**
   * Acquire lock with NX and PX.
   * @returns {Promise<boolean>}
   */
  async acquireLock() {
    try {
      const result = await this.redis.set(this.lockKey, this.instanceId, 'NX', 'PX', this.ttlMs);
      if (result === 'OK') {
        this.isOwner = true;
        this.startHeartbeat();
        this.logger.info({ lockKey: this.lockKey, instanceId: this.instanceId }, 'Redis session lock acquired successfully.');
        return true;
      }
      this.isOwner = false;
      const currentHolder = await this.redis.get(this.lockKey);
      this.logger.warn({ lockKey: this.lockKey, currentHolder, instanceId: this.instanceId }, 'Lock acquisition failed. Active instance detected.');
      return false;
    } catch (err) {
      this.logger.error({ err: err.message }, 'Error attempting to acquire Redis session lock.');
      return false;
    }
  }

  /**
   * Start periodic heartbeat renewal.
   */
  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (!this.isOwner) return;
      try {
        const renewed = await this.redis.eval(this.renewLua, 1, this.lockKey, this.instanceId, this.ttlMs);
        if (renewed !== 1) {
          this.logger.warn({ lockKey: this.lockKey, instanceId: this.instanceId }, 'Session lock heartbeat renewal failed. Lock ownership lost.');
          this.isOwner = false;
          this.stopHeartbeat();
        }
      } catch (err) {
        this.logger.error({ err: err.message }, 'Exception during session lock heartbeat renewal.');
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop periodic heartbeat.
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Safely release lock using atomic Lua script.
   * @returns {Promise<boolean>}
   */
  async releaseLock() {
    this.stopHeartbeat();
    if (!this.isOwner) return true;

    try {
      const released = await this.redis.eval(this.releaseLua, 1, this.lockKey, this.instanceId);
      this.isOwner = false;
      this.logger.info({ lockKey: this.lockKey, instanceId: this.instanceId, released: released === 1 }, 'Redis session lock released.');
      return released === 1;
    } catch (err) {
      this.logger.error({ err: err.message }, 'Error releasing Redis session lock.');
      return false;
    }
  }

  isHeld() {
    return this.isOwner;
  }

  getInstanceId() {
    return this.instanceId;
  }

  getLockKey() {
    return this.lockKey;
  }
}

module.exports = RedisSessionLock;
