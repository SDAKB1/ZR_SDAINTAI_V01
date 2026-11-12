'use strict';

/**
 * Unified PI/PO HTTP Client Module
 *
 * Consolidates HTTP functionality from:
 * - srv/utils/pipoClient.js (pipoGet, httpGet functions)
 * - srv/utils/pipoSoapClient.js (_request method)
 * - srv/utils/pipoDiscovery.js (httpGet, httpPost functions)
 *
 * Provides a unified HTTP client for PI/PO connectivity with:
 * - Shared HTTP methods (get, post, request)
 * - Configurable timeout/retry settings
 * - Proper error handling with cause preservation
 * - Support for both REST and SOAP operations
 *
 * @module pipoHttpClient
 */

const cds = require('@sap/cds');
const { randomUUID } = require('crypto');

const { Timeouts, Destinations, HttpHeaders, XiNamespaces } = require('./constants');

// Lazy load HTTP client
let executeHttpRequest = null;
function getHttpClient() {
  if (!executeHttpRequest) {
    try {
      executeHttpRequest = require('@sap-cloud-sdk/http-client').executeHttpRequest;
    } catch (e) {
      // Mock for development
      executeHttpRequest = async () => ({
        data: '<?xml version="1.0"?><soapenv:Envelope></soapenv:Envelope>',
        status: 200,
        headers: {},
      });
    }
  }
  return executeHttpRequest;
}

// Logger
let _log;
const LOG = () => {
  if (!_log) _log = cds.log('pipo-http-client');
  return _log;
};

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP RESPONSE TYPE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} HttpResponse
 * @property {boolean} success - Whether the request succeeded
 * @property {number} status - HTTP status code
 * @property {*} data - Response body
 * @property {Object} headers - Response headers
 * @property {string} [error] - Error message if failed
 * @property {string} [correlationId] - Request correlation ID
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PIPO HTTP CLIENT CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PipoHttpClient provides unified HTTP access to PI/PO systems.
 * Supports both REST and SOAP operations with configurable timeouts.
 */
class PipoHttpClient {
  /**
   * Create a PipoHttpClient instance
   * @param {string} destinationName - BTP destination name
   * @param {Object} options - Configuration options
   * @param {number} options.timeout - Default timeout in ms (default: Timeouts.DEFAULT)
   * @param {number} options.longTimeout - Timeout for large operations (default: Timeouts.LONG)
   * @param {number} options.retryAttempts - Number of retry attempts (default: 0)
   * @param {number} options.retryDelay - Delay between retries in ms (default: 1000)
   */
  constructor(destinationName, options = {}) {
    this.destinationName = destinationName;
    this.timeout = options.timeout || Timeouts.DEFAULT;
    this.longTimeout = options.longTimeout || Timeouts.LONG;
    this.retryAttempts = options.retryAttempts || 0;
    this.retryDelay = options.retryDelay || 1000;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CORE HTTP METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute a generic HTTP request
   * @param {string} path - Request path
   * @param {Object} options - Request options
   * @param {string} options.method - HTTP method (default: 'GET')
   * @param {Object} options.params - Query parameters
   * @param {*} options.data - Request body
   * @param {Object} options.headers - Additional headers
   * @param {number} options.timeout - Request timeout in ms
   * @param {string} options.correlationId - Correlation ID for tracing
   * @param {boolean} options.returnRaw - Return raw response instead of wrapped
   * @returns {Promise<HttpResponse>} HTTP response
   */
  async request(path, options = {}) {
    const correlationId = options.correlationId || randomUUID();
    const method = (options.method || 'GET').toUpperCase();
    const timeout = options.timeout || this.timeout;

    LOG().debug(`[${method}] ${this.destinationName} ${path}`, {
      params: options.params,
      correlationId,
    });

    const config = {
      method,
      url: path,
      timeout,
      headers: {
        Accept: HttpHeaders.ACCEPT_XML,
        'X-Correlation-ID': correlationId,
        ...options.headers,
      },
    };

    if (options.params) {
      config.params = options.params;
    }

    if (options.data) {
      config.data = options.data;
      if (!config.headers['Content-Type']) {
        config.headers['Content-Type'] = HttpHeaders.CONTENT_TYPE_XML;
      }
    }

    try {
      const httpClient = getHttpClient();
      const response = await this._executeWithRetry(httpClient, config);

      if (options.returnRaw) {
        return response;
      }

      return {
        success: true,
        status: response.status,
        data: response.data,
        headers: response.headers,
        correlationId,
      };
    } catch (error) {
      LOG().error(`[${method}] ${this.destinationName} ${path} failed`, {
        error: error.message,
        correlationId,
      });

      if (options.returnRaw) {
        throw this._wrapError(error, path, method);
      }

      return {
        success: false,
        status: error.response?.status,
        error: error.message,
        data: error.response?.data,
        correlationId,
      };
    }
  }

  /**
   * Execute HTTP GET request
   * @param {string} path - Request path
   * @param {Object} params - Query parameters
   * @param {Object} options - Additional options
   * @returns {Promise<HttpResponse>} HTTP response
   */
  async get(path, params = {}, options = {}) {
    return this.request(path, {
      method: 'GET',
      params,
      ...options,
    });
  }

  /**
   * Execute HTTP GET request returning raw data (throws on error)
   * Compatible with original pipoClient.pipoGet behavior
   * @param {string} path - Request path
   * @param {Object} params - Query parameters
   * @param {Object} options - Additional options
   * @returns {Promise<*>} Response data
   * @throws {Error} On HTTP error
   */
  async getRaw(path, params = {}, options = {}) {
    const response = await this.request(path, {
      method: 'GET',
      params,
      returnRaw: true,
      ...options,
    });
    return response.data;
  }

  /**
   * Execute HTTP GET request expecting JSON response
   * @param {string} path - Request path
   * @param {Object} params - Query parameters
   * @param {Object} options - Additional options
   * @returns {Promise<HttpResponse>} HTTP response
   */
  async getJson(path, params = {}, options = {}) {
    return this.request(path, {
      method: 'GET',
      params,
      headers: { Accept: HttpHeaders.ACCEPT_JSON },
      ...options,
    });
  }

  /**
   * Execute HTTP POST request
   * @param {string} path - Request path
   * @param {*} data - Request body
   * @param {Object} params - Query parameters
   * @param {Object} options - Additional options
   * @returns {Promise<HttpResponse>} HTTP response
   */
  async post(path, data, params = {}, options = {}) {
    return this.request(path, {
      method: 'POST',
      data,
      params,
      ...options,
    });
  }

  /**
   * Execute HTTP POST request returning raw data (throws on error)
   * @param {string} path - Request path
   * @param {*} data - Request body
   * @param {Object} params - Query parameters
   * @param {Object} options - Additional options
   * @returns {Promise<*>} Response data
   * @throws {Error} On HTTP error
   */
  async postRaw(path, data, params = {}, options = {}) {
    const response = await this.request(path, {
      method: 'POST',
      data,
      params,
      returnRaw: true,
      ...options,
    });
    return response.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SOAP METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute SOAP request
   * @param {string} servicePath - SOAP service path
   * @param {string} operation - SOAP operation name
   * @param {string} namespace - SOAP namespace
   * @param {string} body - SOAP body XML content
   * @param {Object} options - Additional options
   * @param {number} options.timeout - Request timeout in ms
   * @param {string} options.correlationId - Correlation ID
   * @returns {Promise<HttpResponse>} HTTP response with SOAP envelope
   */
  async soapRequest(servicePath, operation, namespace, body = '', options = {}) {
    const envelope = this._buildSoapEnvelope(operation, namespace, body);
    const soapAction = `${namespace}/${operation}`;

    return this.request(servicePath, {
      method: 'POST',
      data: envelope,
      headers: {
        'Content-Type': HttpHeaders.CONTENT_TYPE_SOAP,
        SOAPAction: soapAction,
        Accept: HttpHeaders.ACCEPT_XML,
      },
      timeout: options.timeout || Timeouts.SOAP,
      correlationId: options.correlationId,
    });
  }

  /**
   * Execute SOAP request and return raw response (throws on error)
   * @param {string} servicePath - SOAP service path
   * @param {string} operation - SOAP operation name
   * @param {string} namespace - SOAP namespace
   * @param {string} body - SOAP body XML content
   * @param {Object} options - Additional options
   * @returns {Promise<*>} Raw SOAP response data
   * @throws {Error} On HTTP or SOAP error
   */
  async soapRequestRaw(servicePath, operation, namespace, body = '', options = {}) {
    const envelope = this._buildSoapEnvelope(operation, namespace, body);
    const soapAction = `${namespace}/${operation}`;

    const response = await this.request(servicePath, {
      method: 'POST',
      data: envelope,
      headers: {
        'Content-Type': HttpHeaders.CONTENT_TYPE_SOAP,
        SOAPAction: soapAction,
        Accept: HttpHeaders.ACCEPT_XML,
      },
      timeout: options.timeout || Timeouts.SOAP,
      correlationId: options.correlationId,
      returnRaw: true,
    });

    return response.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INTEGRATION SUITE METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Call Integration Suite API
   * @param {string} path - API path
   * @param {string} method - HTTP method (default: 'GET')
   * @param {*} data - Request body
   * @param {Object} options - Additional options
   * @returns {Promise<HttpResponse>} HTTP response
   */
  async callIS(path, method = 'GET', data = null, options = {}) {
    const requestOptions = {
      method,
      headers: {
        'Content-Type': HttpHeaders.CONTENT_TYPE_JSON,
        Accept: HttpHeaders.ACCEPT_JSON,
      },
      ...options,
    };

    if (data) {
      requestOptions.data = data;
    }

    return this.request(path, requestOptions);
  }

  /**
   * Call Integration Suite API returning raw data (throws on error)
   * Compatible with original pipoClient.callIS behavior
   * @param {string} path - API path
   * @param {string} method - HTTP method (default: 'GET')
   * @param {*} data - Request body
   * @param {Object} options - Additional options
   * @returns {Promise<*>} Response data
   * @throws {Error} On HTTP error
   */
  async callISRaw(path, method = 'GET', data = null, options = {}) {
    const requestOptions = {
      method,
      headers: {
        'Content-Type': HttpHeaders.CONTENT_TYPE_JSON,
        Accept: HttpHeaders.ACCEPT_JSON,
      },
      returnRaw: true,
      ...options,
    };

    if (data) {
      requestOptions.data = data;
    }

    const response = await this.request(path, requestOptions);
    return response.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute request with retry logic
   * @private
   */
  async _executeWithRetry(httpClient, config) {
    let lastError;

    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        return await httpClient({ destinationName: this.destinationName }, config);
      } catch (error) {
        lastError = error;

        // Don't retry on client errors (4xx)
        if (error.response?.status >= 400 && error.response?.status < 500) {
          throw error;
        }

        // Retry on server errors (5xx) or network errors
        if (attempt < this.retryAttempts) {
          LOG().warn(`Request failed, retrying (${attempt + 1}/${this.retryAttempts})`, {
            error: error.message,
          });
          await this._delay(this.retryDelay * (attempt + 1));
        }
      }
    }

    throw lastError;
  }

  /**
   * Build SOAP envelope
   * @private
   */
  _buildSoapEnvelope(operation, namespace, body) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${XiNamespaces.SOAP_ENV}" xmlns:ns="${namespace}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:${operation}>
      ${body}
    </ns:${operation}>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /**
   * Wrap error with context
   * @private
   */
  _wrapError(error, path, method) {
    const statusCode = error.response?.status || error.code || 'UNKNOWN';
    const message = error.response?.data || error.message;
    const wrappedError = new Error(`PI/PO request failed [${statusCode}]: ${path} - ${message}`);
    wrappedError.cause = error;
    wrappedError.statusCode = statusCode;
    wrappedError.path = path;
    wrappedError.method = method;
    return wrappedError;
  }

  /**
   * Delay helper for retries
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-CONFIGURED CLIENTS (SINGLETONS)
// ═══════════════════════════════════════════════════════════════════════════════

// Lazy-initialized clients
let _dirClient = null;
let _esrClient = null;
let _isClient = null;

/**
 * Get pre-configured client for Integration Directory
 * @returns {PipoHttpClient} Directory client
 */
function getDirClient() {
  if (!_dirClient) {
    _dirClient = new PipoHttpClient(Destinations.DIR, {
      timeout: Timeouts.DEFAULT,
      longTimeout: Timeouts.LONG,
    });
  }
  return _dirClient;
}

/**
 * Get pre-configured client for Enterprise Services Repository
 * @returns {PipoHttpClient} ESR client
 */
function getEsrClient() {
  if (!_esrClient) {
    _esrClient = new PipoHttpClient(Destinations.ESR, {
      timeout: Timeouts.DEFAULT,
      longTimeout: Timeouts.LONG,
    });
  }
  return _esrClient;
}

/**
 * Get pre-configured client for Integration Suite
 * @returns {PipoHttpClient} IS client
 */
function getIsClient() {
  if (!_isClient) {
    _isClient = new PipoHttpClient(Destinations.IS_API, {
      timeout: Timeouts.SHORT,
    });
  }
  return _isClient;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE FUNCTIONS (backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * HTTP GET to PI/PO Directory (compatible with pipoClient.pipoGet)
 * @param {string} path - Request path
 * @param {Object} params - Query parameters
 * @param {Object} options - Additional options
 * @returns {Promise<*>} Response data
 */
async function pipoGet(path, params = {}, options = {}) {
  return getDirClient().getRaw(path, params, options);
}

/**
 * HTTP GET to PI/PO ESR
 * @param {string} path - Request path
 * @param {Object} params - Query parameters
 * @param {Object} options - Additional options
 * @returns {Promise<*>} Response data
 */
async function esrGet(path, params = {}, options = {}) {
  return getEsrClient().getRaw(path, params, options);
}

/**
 * HTTP GET with wrapped response (compatible with pipoDiscovery.httpGet)
 * @param {string} dest - Destination name
 * @param {string} path - Request path
 * @param {Object} params - Query parameters
 * @param {Object} options - Additional options
 * @returns {Promise<HttpResponse>} Wrapped HTTP response
 */
async function httpGet(dest, path, params = {}, options = {}) {
  const client = new PipoHttpClient(dest, {
    timeout: options.timeout || Timeouts.DEFAULT,
  });
  return client.get(path, params, options);
}

/**
 * HTTP POST with wrapped response (compatible with pipoDiscovery.httpPost)
 * @param {string} dest - Destination name
 * @param {string} path - Request path
 * @param {*} data - Request body
 * @param {Object} params - Query parameters
 * @param {Object} options - Additional options
 * @returns {Promise<HttpResponse>} Wrapped HTTP response
 */
async function httpPost(dest, path, data, params = {}, options = {}) {
  const client = new PipoHttpClient(dest, {
    timeout: options.timeout || Timeouts.DEFAULT,
  });
  return client.post(path, data, params, options);
}

/**
 * Call Integration Suite API (compatible with pipoClient.callIS)
 * @param {string} path - API path
 * @param {string} method - HTTP method
 * @param {*} data - Request body
 * @param {Object} options - Additional options
 * @returns {Promise<*>} Response data
 */
async function callIS(path, method = 'GET', data = null, options = {}) {
  return getIsClient().callISRaw(path, method, data, options);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Main class
  PipoHttpClient,

  // Pre-configured client getters
  getDirClient,
  getEsrClient,
  getIsClient,

  // Backward-compatible convenience functions
  pipoGet,
  esrGet,
  httpGet,
  httpPost,
  callIS,

  // Re-export useful constants
  Timeouts,
  Destinations,
  HttpHeaders,
};
