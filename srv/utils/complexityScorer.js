'use strict';

/**
 * Unified Complexity Scoring Module
 *
 * Consolidates complexity scoring logic from:
 * - srv/brain-service.js (scoreComplexityNode function)
 * - srv/utils/pipoClient.js (scoreComplexity function)
 * - srv/utils/pipoDiscovery.js (assessMigrationComplexity function)
 *
 * Provides a unified API for scoring migration complexity of PI/PO artifacts.
 *
 * @module complexityScorer
 */

const {
  ComplexityTier,
  ComplexityThresholds,
  ComplexityWeights,
  ComplexityPatterns,
  SapMigrationStatus,
} = require('./constants');

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLEXITY SCORER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ComplexityScorer provides unified complexity scoring for PI/PO artifacts.
 * Supports multiple scoring modes for different use cases.
 */
class ComplexityScorer {
  /**
   * Create a ComplexityScorer instance
   * @param {Object} options - Configuration options
   * @param {number} options.maxScore - Maximum normalized score (default: 100)
   * @param {number} options.normalizer - Divisor for raw score normalization (default: 30)
   */
  constructor(options = {}) {
    this.maxScore = options.maxScore || 100;
    this.normalizer = options.normalizer || 30;
  }

  /**
   * Score artifact complexity using quick pattern matching.
   * Equivalent to the original pipoClient.scoreComplexity function.
   *
   * @param {Object|string} artifact - Artifact object or JSON string to analyze
   * @returns {Object} Complexity result with score and tier
   * @returns {number} result.score - Normalized score (0-100)
   * @returns {string} result.tier - Complexity tier (Simple, Medium, Complex)
   */
  scoreQuick(artifact) {
    const rawScore = this._calculateRawScore(artifact);
    const tier = this._determineTier(rawScore);

    return {
      score: this._normalizeScore(rawScore),
      tier,
    };
  }

  /**
   * Score artifact complexity with detailed analysis.
   * Equivalent to the original pipoDiscovery.assessMigrationComplexity function.
   *
   * @param {Object|string} artifact - Artifact object or JSON string to analyze
   * @returns {Object} Detailed complexity assessment
   * @returns {number} result.score - Normalized score (0-100)
   * @returns {string} result.tier - Complexity tier (Simple, Medium, Complex)
   * @returns {string[]} result.factors - Detected complexity factors
   * @returns {string[]} result.recommendations - Migration recommendations
   * @returns {number} result.rawScore - Unnormalized score for debugging
   */
  scoreDetailed(artifact) {
    const artifactStr = this._stringify(artifact);
    const { rawScore, factors, recommendations } = this._analyzeDetailed(artifactStr);
    const tier = this._determineTier(rawScore);

    return {
      score: this._normalizeScore(rawScore),
      tier,
      factors,
      recommendations,
      rawScore,
    };
  }

  /**
   * Score artifact using the brain service's multi-dimensional analysis.
   * Equivalent to the original brain-service.js scoreComplexityNode logic.
   *
   * @param {Object} input - Structured input object with artifact metadata
   * @param {number} input.segmentCount - Number of IDoc/message segments
   * @param {boolean} input.hasZFields - Whether artifact has Z-field extensions
   * @param {string} input.mappingType - Mapping type (java, abap, xslt, graphical)
   * @param {number} input.volumePerDay - Message volume per day
   * @param {string} input.adapterType - Adapter type (as2, jms, jdbc, rfc, etc.)
   * @param {boolean} input.isEdiBased - Whether artifact is EDI-based
   * @param {boolean} input.isBpmProcess - Whether artifact is a BPM process
   * @param {string} input.objectType - Optional object type for context
   * @returns {Object} Multi-dimensional complexity assessment
   */
  scoreMultiDimensional(input) {
    let score = 0;
    const dimensions = {};

    // Segment complexity
    if (input.segmentCount > 15) {
      score += ComplexityWeights.LARGE_SEGMENTS;
      dimensions.segments = 'high';
    } else if (input.segmentCount > 5) {
      score += ComplexityWeights.MEDIUM_SEGMENTS;
      dimensions.segments = 'medium';
    } else {
      score += 1;
      dimensions.segments = 'low';
    }

    // Z-field extensions
    if (input.hasZFields) {
      score += ComplexityWeights.Z_FIELDS;
      dimensions.customFields = true;
    }

    // Mapping type
    const mappingType = (input.mappingType || '').toLowerCase();
    if (mappingType === 'java' || mappingType === 'abap') {
      score += ComplexityWeights.JAVA_ABAP;
      dimensions.mappingComplexity = 'custom';
    } else if (mappingType === 'xslt') {
      score += ComplexityWeights.XSLT;
      dimensions.mappingComplexity = 'xslt';
    } else {
      dimensions.mappingComplexity = 'standard';
    }

    // Volume
    if (input.volumePerDay > 100000) {
      score += ComplexityWeights.HIGH_VOLUME;
      dimensions.volume = 'high';
    } else if (input.volumePerDay > 10000) {
      score += ComplexityWeights.MEDIUM_VOLUME;
      dimensions.volume = 'medium';
    } else {
      dimensions.volume = 'low';
    }

    // Adapter type
    const adapterType = (input.adapterType || '').toLowerCase();
    if (adapterType === 'as2' || adapterType === 'jms' || adapterType === 'custom') {
      score += ComplexityWeights.AS2_JMS;
      dimensions.adapter = 'complex';
    } else if (adapterType === 'jdbc' || adapterType === 'rfc') {
      score += ComplexityWeights.JDBC_RFC;
      dimensions.adapter = 'moderate';
    } else {
      dimensions.adapter = 'standard';
    }

    // EDI-based
    if (input.isEdiBased) {
      score += ComplexityWeights.EDI;
      dimensions.edi = true;
    }

    // BPM process
    if (input.isBpmProcess) {
      score += ComplexityWeights.BPM;
      dimensions.bpm = true;
    }

    // Finance/HR context elevation
    const objectType = (input.objectType || '').toUpperCase();
    if (
      objectType.includes('_FI') ||
      objectType.includes('_HR') ||
      objectType.includes('FINANCE') ||
      objectType.includes('HR')
    ) {
      score += ComplexityWeights.FINANCE_HR;
      dimensions.criticalDomain = true;
    }

    const tier = this._determineTier(score);

    return {
      score: this._normalizeScore(score),
      tier,
      rawScore: score,
      dimensions,
      sapStatus: this.tierToSapStatus(tier),
    };
  }

  /**
   * Convert tier to SAP Migration Assessment Tool status terminology
   * @param {string} tier - Complexity tier (Simple, Medium, Complex)
   * @returns {string} SAP migration status
   */
  tierToSapStatus(tier) {
    const tierLower = (tier || '').toLowerCase();
    if (tierLower === 'simple') return SapMigrationStatus.SIMPLE;
    if (tierLower === 'medium') return SapMigrationStatus.MEDIUM;
    return SapMigrationStatus.COMPLEX;
  }

  /**
   * Get SAP status directly from a score
   * @param {number} rawScore - Raw complexity score
   * @returns {string} SAP migration status
   */
  scoreToSapStatus(rawScore) {
    const tier = this._determineTier(rawScore);
    return this.tierToSapStatus(tier);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Convert artifact to lowercase string for pattern matching
   * @private
   */
  _stringify(artifact) {
    if (typeof artifact === 'string') {
      return artifact.toLowerCase();
    }
    return JSON.stringify(artifact).toLowerCase();
  }

  /**
   * Calculate raw score using pattern matching
   * @private
   */
  _calculateRawScore(artifact) {
    const a = this._stringify(artifact);
    let score = 0;

    // BPM/ccBPM
    if (ComplexityPatterns.BPM.some(p => a.includes(p))) {
      score += ComplexityWeights.BPM;
    }

    // Custom code (Java/ABAP)
    if (ComplexityPatterns.CUSTOM_CODE.some(p => a.includes(p))) {
      score += ComplexityWeights.JAVA_ABAP;
    }

    // XSLT
    if (ComplexityPatterns.XSLT.some(p => a.includes(p))) {
      score += ComplexityWeights.XSLT;
    }

    // AS2/JMS adapters
    if (ComplexityPatterns.AS2_JMS.some(p => a.includes(p))) {
      score += ComplexityWeights.AS2_JMS;
    }

    // JDBC/RFC adapters
    if (ComplexityPatterns.JDBC_RFC.some(p => a.includes(p))) {
      score += ComplexityWeights.JDBC_RFC;
    }

    // EDI/EDIFACT
    if (ComplexityPatterns.EDI.some(p => a.includes(p))) {
      score += ComplexityWeights.EDI;
    }

    // Z-fields
    if (ComplexityPatterns.Z_FIELDS.some(p => a.includes(p))) {
      score += ComplexityWeights.Z_FIELDS;
    }

    return score;
  }

  /**
   * Analyze artifact with detailed factor tracking and recommendations
   * @private
   */
  _analyzeDetailed(artifactStr) {
    let rawScore = 0;
    const factors = [];
    const recommendations = [];

    // BPM/ccBPM
    if (ComplexityPatterns.BPM.some(p => artifactStr.includes(p))) {
      rawScore += ComplexityWeights.BPM;
      factors.push('BPM');
      recommendations.push('Requires redesign as Integration Flow with subprocess');
    }

    // Custom code
    if (ComplexityPatterns.CUSTOM_CODE.some(p => artifactStr.includes(p))) {
      rawScore += ComplexityWeights.JAVA_ABAP;
      factors.push('Custom Code');
      recommendations.push('Review Java/ABAP mapping for Groovy/XSLT conversion');
    }

    // XSLT
    if (ComplexityPatterns.XSLT.some(p => artifactStr.includes(p))) {
      rawScore += ComplexityWeights.XSLT;
      factors.push('XSLT');
      recommendations.push('XSLT can be reused with minor adjustments');
    }

    // AS2/JMS
    if (ComplexityPatterns.AS2_JMS.some(p => artifactStr.includes(p))) {
      rawScore += ComplexityWeights.AS2_JMS;
      factors.push('AS2/JMS');
      recommendations.push('Requires CPI AS2/JMS adapter configuration');
    }

    // JDBC/RFC
    if (ComplexityPatterns.JDBC_RFC.some(p => artifactStr.includes(p))) {
      rawScore += ComplexityWeights.JDBC_RFC;
      factors.push('JDBC/RFC');
      recommendations.push('Use CPI JDBC/RFC adapters with on-premise connectivity');
    }

    // EDI
    if (ComplexityPatterns.EDI.some(p => artifactStr.includes(p))) {
      rawScore += ComplexityWeights.EDI;
      factors.push('EDI');
      recommendations.push('Use CPI EDI/EDIFACT capabilities or B2B Trading Partner');
    }

    // Z-fields
    if (ComplexityPatterns.Z_FIELDS.some(p => artifactStr.includes(p))) {
      rawScore += ComplexityWeights.Z_FIELDS;
      factors.push('Z-Fields');
      recommendations.push('Custom field extensions need review for CPI compatibility');
    }

    return { rawScore, factors, recommendations };
  }

  /**
   * Determine complexity tier from raw score
   * @private
   */
  _determineTier(rawScore) {
    if (rawScore <= ComplexityThresholds.SIMPLE_MAX) {
      return ComplexityTier.SIMPLE;
    }
    if (rawScore <= ComplexityThresholds.MEDIUM_MAX) {
      return ComplexityTier.MEDIUM;
    }
    return ComplexityTier.COMPLEX;
  }

  /**
   * Normalize raw score to 0-100 range
   * @private
   */
  _normalizeScore(rawScore) {
    return Math.min(this.maxScore, Math.round((rawScore / this.normalizer) * this.maxScore));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE FUNCTIONS (for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

// Default scorer instance
const defaultScorer = new ComplexityScorer();

/**
 * Quick complexity score (backward compatible with pipoClient.scoreComplexity)
 * @param {Object|string} artifact - Artifact to analyze
 * @returns {Object} Result with score and tier
 */
function scoreComplexity(artifact) {
  return defaultScorer.scoreQuick(artifact);
}

/**
 * Detailed complexity assessment (backward compatible with pipoDiscovery.assessMigrationComplexity)
 * @param {Object|string} artifact - Artifact to analyze
 * @returns {Object} Detailed assessment with factors and recommendations
 */
function assessMigrationComplexity(artifact) {
  return defaultScorer.scoreDetailed(artifact);
}

/**
 * Multi-dimensional scoring (backward compatible with brain-service scoreComplexityNode)
 * @param {Object} input - Structured artifact metadata
 * @returns {Object} Multi-dimensional assessment
 */
function scoreMultiDimensional(input) {
  return defaultScorer.scoreMultiDimensional(input);
}

/**
 * Convert tier to SAP migration status
 * @param {string} tier - Complexity tier
 * @returns {string} SAP migration status
 */
function tierToSapStatus(tier) {
  return defaultScorer.tierToSapStatus(tier);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Class export for custom configuration
  ComplexityScorer,

  // Convenience functions
  scoreComplexity,
  assessMigrationComplexity,
  scoreMultiDimensional,
  tierToSapStatus,

  // Re-export constants for convenience
  ComplexityTier,
  ComplexityThresholds,
  ComplexityWeights,
  ComplexityPatterns,
};
