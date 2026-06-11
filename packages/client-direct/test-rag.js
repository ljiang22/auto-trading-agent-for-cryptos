import { FileProcessor } from './dist/fileProcessor.js';
import fs from 'fs';
import path from 'path';

// Mock AgentRuntime for testing
const mockRuntime = {
    agentId: 'test-agent-123',
    messageManager: {
        addEmbeddingToMemory: async (memory) => {
            console.log('✅ Generated embedding for memory:', memory.id);
            return memory;
        },
        createMemory: async (memory) => {
            console.log('✅ Stored memory:', memory.id, '- Text length:', memory.content.text.length);
            return memory;
        },
        searchMemoriesByEmbedding: async (query, options) => {
            console.log('🔍 Searching for:', query);
            return []; // Return empty for this test
        }
    }
};

async function testRAG() {
    console.log('🧪 Testing RAG functionality...\n');
    
    try {
        // Copy test file to upload directory
        const uploadDir = path.join(process.cwd(), '../../data/uploaded');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        
        const testFile = '/tmp/test-document.txt';
        const uploadedFile = path.join(uploadDir, 'test-crypto-analysis.txt');
        
        fs.copyFileSync(testFile, uploadedFile);
        console.log('📁 Test file copied to upload directory');
        
        // Initialize file processor
        const fileProcessor = new FileProcessor(mockRuntime, 500, 100); // Smaller chunks for testing
        
        // Process the file
        await fileProcessor.processFile(
            uploadedFile,
            'test-crypto-analysis.txt',
            'text/plain',
            'test-room-123'
        );
        
        console.log('\n✅ RAG processing completed successfully!');
        
        // Test search functionality
        console.log('\n🔍 Testing search functionality...');
        const searchResults = await fileProcessor.searchChunks(
            'technical analysis indicators',
            'test-room-123',
            3
        );
        
        console.log(`Found ${searchResults.length} relevant chunks`);
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

testRAG();