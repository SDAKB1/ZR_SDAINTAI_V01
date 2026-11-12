/**
 * HANA-based Cache Layer for PI/PO Discovery
 * Provides tenant-isolated caching with TTL support
 *
 * Based on north_star.md architecture specification
 */
const cds = require('@sap/cds');

class HANACache {
  constructor(tenantId, defaultTtlHours = 24) {
    this.tenantId = tenantId;
    this.defaultTtlMs = defaultTtlHours * 60 * 60 * 1000;
  }

  /**
   * Get cached data for a resource
   * @param {string} resourceType - Type of resource (ico_list, ico_detail, channel, mapping, etc.)
   * @param {string} resourceId - Specific resource ID or '__all__' for lists
   * @returns {Promise<object|null>} Cached data or null if expired/missing
   */
  async get(resourceType, resourceId = '__all__') {
    const db = await cds.connect.to('db');
    const { PIPOCache } = db.entities('tenant');

    const result = await SELECT.one.from(PIPOCache).where({
      tenant_ID: this.tenantId,
      resourceType: resourceType,
      resourceId: resourceId,
      expiresAt: { '>': new Date() },
    });

    if (result && result.data) {
      try {
        return JSON.parse(result.data);
      } catch (e) {
        return result.data;
      }
    }
    return null;
  }

  /**
   * Set cached data with TTL
   * @param {string} resourceType - Type of resource
   * @param {any} data - Data to cache
   * @param {string} resourceId - Specific resource ID or '__all__'
   * @param {number} ttlMs - Time to live in milliseconds (optional)
   */
  async set(resourceType, data, resourceId = '__all__', ttlMs = null) {
    const db = await cds.connect.to('db');
    const { PIPOCache } = db.entities('tenant');

    const expiresAt = new Date(Date.now() + (ttlMs || this.defaultTtlMs));
    const jsonData = typeof data === 'string' ? data : JSON.stringify(data);

    await UPSERT.into(PIPOCache).entries({
      tenant_ID: this.tenantId,
      resourceType: resourceType,
      resourceId: resourceId,
      data: jsonData,
      expiresAt: expiresAt,
      updatedAt: new Date(),
    });
  }

  // Convenience methods for specific resource types

  async getICOs() {
    return this.get('ico_list');
  }

  async setICOs(icos, ttlMs = 24 * 60 * 60 * 1000) {
    return this.set('ico_list', icos, '__all__', ttlMs);
  }

  async getICODetail(icoId) {
    return this.get('ico_detail', icoId);
  }

  async setICODetail(icoId, detail, ttlMs = 12 * 60 * 60 * 1000) {
    return this.set('ico_detail', detail, icoId, ttlMs);
  }

  async getChannels() {
    return this.get('channel_list');
  }

  async setChannels(channels, ttlMs = 24 * 60 * 60 * 1000) {
    return this.set('channel_list', channels, '__all__', ttlMs);
  }

  async getChannelDetail(channelId) {
    return this.get('channel_detail', channelId);
  }

  async setChannelDetail(channelId, detail, ttlMs = 12 * 60 * 60 * 1000) {
    return this.set('channel_detail', detail, channelId, ttlMs);
  }

  async getMappings() {
    return this.get('mapping_list');
  }

  async setMappings(mappings, ttlMs = 24 * 60 * 60 * 1000) {
    return this.set('mapping_list', mappings, '__all__', ttlMs);
  }

  async getValueMappings() {
    return this.get('valuemapping_list');
  }

  async setValueMappings(valueMappings, ttlMs = 24 * 60 * 60 * 1000) {
    return this.set('valuemapping_list', valueMappings, '__all__', ttlMs);
  }

  async getBusinessSystems() {
    return this.get('businesssystem_list');
  }

  async setBusinessSystems(systems, ttlMs = 48 * 60 * 60 * 1000) {
    return this.set('businesssystem_list', systems, '__all__', ttlMs);
  }

  async getSWCVs() {
    return this.get('swcv_list');
  }

  async setSWCVs(swcvs, ttlMs = 48 * 60 * 60 * 1000) {
    return this.set('swcv_list', swcvs, '__all__', ttlMs);
  }

  /**
   * Invalidate cache entries
   * @param {string} resourceType - Optional: specific resource type
   * @param {string} resourceId - Optional: specific resource ID
   */
  async invalidate(resourceType = null, resourceId = null) {
    const db = await cds.connect.to('db');
    const { PIPOCache } = db.entities('tenant');

    const where = { tenant_ID: this.tenantId };
    if (resourceType) where.resourceType = resourceType;
    if (resourceId) where.resourceId = resourceId;

    await DELETE.from(PIPOCache).where(where);
  }

  /**
   * Clean up expired cache entries (run periodically)
   */
  async cleanupExpired() {
    const db = await cds.connect.to('db');
    const { PIPOCache } = db.entities('tenant');

    await DELETE.from(PIPOCache).where({
      expiresAt: { '<': new Date() },
    });
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    const db = await cds.connect.to('db');
    const { PIPOCache } = db.entities('tenant');

    const total = await SELECT.one.from(PIPOCache).columns('count(*) as count').where({ tenant_ID: this.tenantId });

    const expired = await SELECT.one
      .from(PIPOCache)
      .columns('count(*) as count')
      .where({
        tenant_ID: this.tenantId,
        expiresAt: { '<': new Date() },
      });

    const byType = await SELECT.from(PIPOCache)
      .columns('resourceType', 'count(*) as count')
      .where({ tenant_ID: this.tenantId })
      .groupBy('resourceType');

    return {
      tenantId: this.tenantId,
      totalEntries: total?.count || 0,
      expiredEntries: expired?.count || 0,
      byResourceType: byType.reduce((acc, row) => {
        acc[row.resourceType] = row.count;
        return acc;
      }, {}),
    };
  }
}

/**
 * Factory function to create tenant-specific cache
 */
function createCache(tenantId, defaultTtlHours = 24) {
  return new HANACache(tenantId, defaultTtlHours);
}

module.exports = { HANACache, createCache };
