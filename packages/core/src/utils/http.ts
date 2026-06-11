/**
 * Global HTTP Agent for unified network connection management across all plugins
 * 
 * This module provides a single, shared keep-alive Agent that prevents TCP connection
 * exhaustion and improves performance on Windows/Linux systems during parallel execution.
 * 
 * Features:
 * - Keep-alive connection pooling
 * - Concurrent connection limits
 * - Platform-optimized timeouts
 * - Shared axios instance with pre-configured Agent
 * - Global axios defaults for existing code
 */

import http from 'http';
import https from 'https';
import axios from 'axios';

/**
 * Global HTTP Agent with keep-alive for connection pooling
 * Configured for optimal performance across all platforms
 */
export const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 50,        // Reasonable concurrent connection limit
    maxFreeSockets: 20,    // Keep connections alive for reuse
    timeout: 60000,        // 60 second timeout
    scheduling: 'fifo'     // First-in-first-out scheduling
});

/**
 * Global HTTPS Agent with keep-alive for secure connections
 * Matches HTTP Agent configuration for consistency
 */
export const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,        // Reasonable concurrent connection limit  
    maxFreeSockets: 20,    // Keep connections alive for reuse
    timeout: 60000,        // 60 second timeout
    scheduling: 'fifo'     // First-in-first-out scheduling
});

/**
 * Pre-configured axios instance with global Agents
 * Ready to use for all HTTP/HTTPS requests across plugins
 */
/**
 * Cap axios response sizes globally. Default in axios is unbounded — a
 * misbehaving upstream returning a multi-GB body would buffer the whole thing
 * into a Buffer (counted as `external` memory in process.memoryUsage), pinning
 * it until GC reclaims the response object. Set 64 MB as the ceiling: well
 * above any legitimate JSON response from CoinMetrics/CoinGlass/Tavily, low
 * enough to fail-fast a runaway upstream.
 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export const httpClient = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 30000,        // 30 second request timeout
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    headers: {
        'User-Agent': 'SentiEdge-Agent/1.0 (Compatible; Bot)',
        'Accept': 'application/json',
        'Connection': 'keep-alive'
    }
});

/**
 * Configure global axios defaults to use our keep-alive Agents
 * This ensures existing axios.get(), axios.post() calls automatically use connection pooling
 */
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 30000;
axios.defaults.maxContentLength = MAX_RESPONSE_BYTES;
axios.defaults.maxBodyLength = MAX_RESPONSE_BYTES;
axios.defaults.headers.common['User-Agent'] = 'SentiEdge-Agent/1.0 (Compatible; Bot)';
axios.defaults.headers.common['Accept'] = 'application/json';
axios.defaults.headers.common['Connection'] = 'keep-alive';



// Export agents and client for direct use
export { httpClient as default };