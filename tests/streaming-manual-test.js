/**
 * Manual test for AWS streaming chunking functionality
 * This can be run directly with node to test the streaming fix
 */

const express = require('express');
const http = require('http');

// Mock a simple version of the DirectClient streaming logic to test
class StreamingTester {
    constructor() {
        this.app = express();
        this.setupRoutes();
    }

    setupRoutes() {
        this.app.use(express.json());

        this.app.post('/test-streaming', (req, res) => {
            console.log('🧪 Testing streaming chunking logic...');
            
            // Set up Server-Sent Events
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Cache-Control'
            });

            // Simulate the comprehensive analysis responses that caused the bug
            this.testStreamingLogic(res, req.body.testType || 'comprehensive');
        });
    }

    async testStreamingLogic(res, testType) {
        let allResponses = [];

        switch (testType) {
            case 'small':
                console.log('📊 Testing small response (should use compact mode)');
                allResponses = this.generateSmallResponses();
                break;
            
            case 'large':
                console.log('📊 Testing large response (should use chunking)');
                allResponses = this.generateLargeResponses();
                break;
                
            case 'comprehensive':
                console.log('📊 Testing comprehensive analysis scenario (original bug)');
                allResponses = this.generateComprehensiveAnalysisResponses();
                break;
                
            case 'huge':
                console.log('📊 Testing huge response (865KB like in logs)');
                allResponses = this.generateHugeResponse();
                break;
        }

        console.log(`📦 Generated ${allResponses.length} responses for testing`);
        
        // Apply the exact same logic as the fix
        await this.applyStreamingLogic(res, allResponses);
        
        res.write(`data: [DONE]\n\n`);
        res.end();
        console.log('✅ Test completed successfully');
    }

    generateSmallResponses() {
        return [
            {
                id: '1',
                content: { text: 'Small response for testing' },
                userId: 'test-user',
                agentId: 'test-agent',
                roomId: 'test-room',
                createdAt: Date.now()
            }
        ];
    }

    generateLargeResponses() {
        // Generate responses that exceed 8KB threshold
        const largeText = 'x'.repeat(3000); // 3KB per response
        return Array.from({ length: 4 }, (_, i) => ({
            id: `response-${i}`,
            content: { text: `Response ${i}: ${largeText}` },
            userId: 'test-user',
            agentId: 'test-agent',
            roomId: 'test-room',
            createdAt: Date.now()
        }));
    }

    generateComprehensiveAnalysisResponses() {
        // Simulate the exact scenario that caused the AWS hang
        return [
            {
                id: 'ai-response',
                content: { text: 'I\'ll perform a comprehensive analysis of BTC using all available data sources...' },
                userId: 'test-agent',
                agentId: 'test-agent',
                roomId: 'test-room',
                createdAt: Date.now()
            },
            // Simulate 12 mandatory actions (as per comprehensive_analysis_actions.ts)
            ...Array.from({ length: 12 }, (_, i) => {
                const actionNames = [
                    'plot_charts', 'GET_ADDRESS_AND_TRANSACTION_DATA', 'getnews', 
                    'Sentiment_Analysis', 'TECHNICAL_ANALYSIS', 'INFLOW_OUTFLOW_ANALYSIS',
                    'GET_TRANSACTION_VOLUME', 'FEAR_GREED_INDEX_ANALYSIS', 'WHALE_ALERT',
                    'CRYPTO_RESEARCH_SEARCH', 'INSTITUTIONAL_CRYPTO_SEARCH', 'PREDICTION'
                ];
                
                return {
                    id: `action-${i}`,
                    content: { 
                        text: `📊 ${actionNames[i]} Analysis Results:\n\n` + 'x'.repeat(4000), // 4KB per action
                        actionName: actionNames[i]
                    },
                    userId: 'test-agent',
                    agentId: 'test-agent',
                    roomId: 'test-room',
                    createdAt: Date.now()
                };
            }),
            {
                id: 'summary',
                content: { 
                    text: `📈 Summary: Comprehensive analysis complete with insights from all data sources...\n\n` + 'x'.repeat(8000),
                    type: 'summary'
                },
                userId: 'test-agent',
                agentId: 'test-agent',
                roomId: 'test-room',
                createdAt: Date.now()
            },
            {
                id: 'comprehensive-analysis',
                content: { 
                    text: `✅ **Report Details:**\n- **Cryptocurrency:** Bitcoin (BTC)\n- **Analysis Period:** Last 30 days\n\n` + 'x'.repeat(20000), // Large final analysis
                    type: 'comprehensive_analysis'
                },
                userId: 'test-agent',
                agentId: 'test-agent',
                roomId: 'test-room',
                createdAt: Date.now()
            }
        ];
    }

    generateHugeResponse() {
        // Generate the exact size that caused the hang (865566 chars)
        return [
            {
                id: 'huge-response',
                content: { 
                    text: 'x'.repeat(865566), // Exact size from the logs
                    type: 'comprehensive_analysis'
                },
                userId: 'test-agent',
                agentId: 'test-agent',
                roomId: 'test-room',
                createdAt: Date.now()
            }
        ];
    }

    async applyStreamingLogic(res, allResponses) {
        // Apply the EXACT same logic as the fix in index.ts
        const finalResponseData = { type: 'final_response', responses: allResponses };
        const finalResponseJson = JSON.stringify(finalResponseData);
        
        console.log(`📏 Total response size: ${finalResponseJson.length} characters`);
        console.log(`📦 Number of responses: ${allResponses.length}`);
        
        // Always use AWS-compatible chunking for all responses (8KB threshold for universal compatibility)
        if (finalResponseJson.length > 8192) {
            console.log(`🔀 Response detected (${finalResponseJson.length} chars, ${allResponses.length} responses), using AWS-compatible chunking for optimal streaming`);
            
            // Send each response individually with delays and error handling
            for (let i = 0; i < allResponses.length; i++) {
                const response = allResponses[i];
                
                // Truncate overly large individual responses for AWS compatibility
                const truncatedResponse = {
                    ...response,
                    content: {
                        ...response.content,
                        text: response.content.text && response.content.text.length > 6144 
                            ? response.content.text.substring(0, 6144) + '\n\n[Content truncated for AWS streaming compatibility]'
                            : response.content.text
                    }
                };
                
                const individualResponseData = { type: 'final_response', responses: [truncatedResponse] };
                const individualJson = JSON.stringify(individualResponseData);
                
                try {
                    res.write(`data: ${individualJson}\n\n`);
                    console.log(`✓ Sent response ${i + 1}/${allResponses.length} (${individualJson.length} chars)`);
                    
                    // Add progressive delay for AWS throttling prevention
                    if (i < allResponses.length - 1) {
                        const delay = Math.min(100 + (i * 25), 500); // 100ms to 500ms max
                        console.log(`⏳ Waiting ${delay}ms before next chunk...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                } catch (streamingError) {
                    console.error(`❌ Failed to send response chunk ${i + 1}/${allResponses.length}:`, streamingError.message);
                    
                    // Try to send error notification to client
                    try {
                        const errorData = { 
                            type: 'streaming_error', 
                            message: `Streaming interrupted at response ${i + 1}/${allResponses.length}`,
                            error: streamingError.message 
                        };
                        res.write(`data: ${JSON.stringify(errorData)}\n\n`);
                    } catch (errorNotificationFailed) {
                        console.error('Failed to send error notification to client');
                        break;
                    }
                    break;
                }
            }
        } else {
            // For smaller responses, still use chunking with delays for AWS compatibility
            console.log(`📤 Small response (${finalResponseJson.length} chars, ${allResponses.length} responses), using AWS-compatible chunking`);
            
            // Send each response individually with delays for universal AWS compatibility
            for (let i = 0; i < allResponses.length; i++) {
                const response = allResponses[i];
                
                // Apply the same truncation logic for consistency
                const truncatedResponse = {
                    ...response,
                    content: {
                        ...response.content,
                        text: response.content.text && response.content.text.length > 6144 
                            ? response.content.text.substring(0, 6144) + '\n\n[Content truncated for AWS streaming compatibility]'
                            : response.content.text
                    }
                };
                
                const individualResponseData = { type: 'final_response', responses: [truncatedResponse] };
                const individualJson = JSON.stringify(individualResponseData);
                
                try {
                    res.write(`data: ${individualJson}\n\n`);
                    console.log(`✓ Sent response ${i + 1}/${allResponses.length} (${individualJson.length} chars)`);
                    
                    // Add progressive delay for AWS throttling prevention (for all responses)
                    if (i < allResponses.length - 1) {
                        const delay = Math.min(100 + (i * 25), 500); // 100ms to 500ms max
                        console.log(`⏳ Waiting ${delay}ms before next chunk...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                } catch (streamingError) {
                    console.error(`❌ Failed to send response chunk ${i + 1}/${allResponses.length}:`, streamingError.message);
                    
                    // Try to send error notification to client
                    try {
                        const errorData = { 
                            type: 'streaming_error', 
                            message: `Streaming interrupted at response ${i + 1}/${allResponses.length}`,
                            error: streamingError.message 
                        };
                        res.write(`data: ${JSON.stringify(errorData)}\n\n`);
                    } catch (errorNotificationFailed) {
                        console.error('Failed to send error notification to client');
                        break;
                    }
                    break;
                }
            }
        }
    }

    start(port = 3001) {
        const server = this.app.listen(port, () => {
            console.log(`🧪 Streaming test server running on http://localhost:${port}`);
            console.log('');
            console.log('Test endpoints:');
            console.log(`  POST /test-streaming {"testType": "small"}`);
            console.log(`  POST /test-streaming {"testType": "large"}`);
            console.log(`  POST /test-streaming {"testType": "comprehensive"}`);
            console.log(`  POST /test-streaming {"testType": "huge"}`);
            console.log('');
            console.log('Example curl commands:');
            console.log(`  curl -X POST http://localhost:${port}/test-streaming -H "Content-Type: application/json" -d '{"testType": "comprehensive"}'`);
            console.log(`  curl -X POST http://localhost:${port}/test-streaming -H "Content-Type: application/json" -d '{"testType": "huge"}'`);
        });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n🛑 Shutting down test server...');
            server.close(() => {
                console.log('✅ Server closed');
                process.exit(0);
            });
        });

        return server;
    }
}

// Auto-run tests if this file is executed directly
if (require.main === module) {
    console.log('🚀 Starting AWS Streaming Chunking Test Server...');
    console.log('');
    
    const tester = new StreamingTester();
    tester.start();
    
    // Run automatic tests after a short delay
    setTimeout(async () => {
        console.log('🤖 Running automatic tests...');
        
        const testCases = ['small', 'large', 'comprehensive', 'huge'];
        
        for (const testType of testCases) {
            console.log(`\n📋 Testing: ${testType}`);
            
            try {
                const response = await fetch('http://localhost:3001/test-streaming', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ testType })
                });
                
                console.log(`✅ ${testType} test completed with status: ${response.status}`);
                
                // Read the stream to ensure it completes
                const reader = response.body?.getReader();
                if (reader) {
                    while (true) {
                        const { done } = await reader.read();
                        if (done) break;
                    }
                }
                
            } catch (error) {
                console.error(`❌ ${testType} test failed:`, error.message);
            }
        }
        
        console.log('\n🏁 All automatic tests completed');
        console.log('Server is still running for manual testing. Press Ctrl+C to exit.');
        
    }, 2000);
}

module.exports = StreamingTester;