# AWS Server-Sent Events (SSE) Deployment Guide

This guide addresses common streaming connection issues when deploying the SentiEdge Agent to AWS, specifically the "Load failed" errors that occur during crypto analysis streaming.

## Problem Description

When deployed on AWS, the application may experience:
- `TypeError: Load failed` errors during streaming
- `Unhandled Promise Rejection` when making streaming requests
- Connection drops during long-running crypto analysis
- Incomplete responses from the `/message/stream` endpoint

## Root Causes

1. **Nginx/Proxy Buffering**: Load balancers and reverse proxies buffer SSE responses
2. **Connection Timeouts**: Default timeouts are too aggressive for long-running analysis
3. **CORS Configuration**: Missing or incorrect CORS headers for production domains
4. **Environment Variables**: Client connecting to localhost instead of production URLs

## Solutions Implemented

### 1. Server-Side Fixes

#### A. Enhanced SSE Headers
The streaming endpoint now includes:
```javascript
'X-Accel-Buffering': 'no'          // Prevents Nginx buffering
'Transfer-Encoding': 'chunked'      // Enables chunked transfer
```

#### B. Connection Keepalive
- Automatic keepalive messages every 15 seconds
- Proper cleanup on connection close/error
- Connection state monitoring

### 2. Client-Side Improvements

#### A. Automatic Retry Logic
- Up to 3 retry attempts for failed connections
- Exponential backoff (1s, 2s, 4s delays)
- User feedback during retry attempts

#### B. Extended Timeouts
- Increased from 5 minutes to 10 minutes for complex analysis
- Better timeout error handling

## Deployment Checklist

### 1. Environment Variables

Set these in your AWS deployment:

```bash
# Production URLs (replace with your actual domains)
SERVER_URL=https://your-api-domain.com
SERVER_PORT=443
VITE_SERVER_URL=https://your-api-domain.com
VITE_SERVER_BASE_URL=https://your-api-domain.com

# CORS Configuration
CORS_ORIGIN=https://your-client-domain.com

# Optional: Streaming Configuration
SSE_KEEPALIVE_INTERVAL=15000
STREAM_TIMEOUT=600000
CONNECTION_RETRY_COUNT=3
```

### 2. Nginx Configuration

If using Nginx as a reverse proxy, apply the configuration from `nginx-sse.conf`:

```nginx
location /api/ {
    proxy_pass http://localhost:3000;
    
    # CRITICAL: Disable buffering for SSE
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header X-Accel-Buffering no;
    
    # Extended timeouts for long analysis
    proxy_read_timeout 600s;
    proxy_connect_timeout 75s;
    proxy_send_timeout 600s;
    
    # HTTP/1.1 for persistent connections
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    chunked_transfer_encoding off;
}
```

### 3. AWS Load Balancer Settings

#### Application Load Balancer (ALB)
- **Idle timeout**: 600 seconds (10 minutes)
- **Target group health check**: 30s timeout, 10s interval
- **Deregistration delay**: 30 seconds

#### Network Load Balancer (NLB)
- Configure target groups with extended timeouts
- Enable connection draining

### 4. AWS CloudFront (if used)

Add these cache behaviors for streaming endpoints:
```
Path pattern: /api/*
Origin request policy: CORS-S3Origin or custom with all headers
Cache policy: CachingDisabled
```

## Testing the Fix

### 1. Basic Connectivity Test
```bash
curl -v https://your-domain.com/agents
```

### 2. SSE Streaming Test
```bash
curl -v -N \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"text":"test analysis","userId":"test","roomId":"test"}' \
  https://your-domain.com/api/your-agent-id/message/stream
```

### 3. Browser Network Tab
- Check that requests return Status 200
- Verify no CORS errors in console
- Confirm SSE messages are received continuously

## Common Issues & Solutions

### Issue: Still getting "Load failed" errors
**Solution**: 
1. Verify `VITE_SERVER_BASE_URL` is set correctly
2. Check Nginx configuration is applied
3. Confirm ALB timeout settings

### Issue: Analysis stops mid-stream
**Solution**:
1. Increase ALB idle timeout to 600+ seconds
2. Verify keepalive messages are being sent (check network tab)
3. Check CloudWatch logs for connection drops

### Issue: CORS errors in browser
**Solution**:
1. Set `CORS_ORIGIN` to your exact client domain
2. Ensure HTTPS consistency between client and server
3. Check Nginx CORS headers configuration

### Issue: Timeouts during complex analysis
**Solution**:
1. Increase `STREAM_TIMEOUT` environment variable
2. Consider breaking complex requests into smaller parts
3. Monitor server resource usage during analysis

## Monitoring

### Server Logs
Monitor for these log messages:
- `📡 Sent SSE keepalive` - Confirms keepalive is working
- `🔌 SSE connection closed` - Normal connection cleanup
- `🔄 Retrying streaming connection` - Client retry attempts

### CloudWatch Metrics
Monitor:
- Target response time
- Healthy host count
- Request count and error rates
- Network bytes in/out

## Support

If issues persist after following this guide:
1. Check server logs for specific error messages
2. Verify all environment variables are set correctly
3. Test with a simple message first before complex analysis
4. Consider enabling debug logging temporarily

This configuration should resolve the majority of SSE streaming issues on AWS deployments.