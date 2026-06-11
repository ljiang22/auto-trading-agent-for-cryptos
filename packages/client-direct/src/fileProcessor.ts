import fs from 'fs';
import path from 'path';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import { elizaLogger, type AgentRuntime, type Memory, stringToUuid, type UUID, embed } from '@elizaos/core';
import * as mammoth from 'mammoth';

export interface DocumentChunk {
    id: string;
    text: string;
    metadata: {
        source: string;
        fileName: string;
        chunkIndex: number;
        totalChunks: number;
        contentType: string;
        page?: number;
    };
}

export class FileProcessor {
    private runtime: AgentRuntime;
    private chunkSize: number;
    private chunkOverlap: number;

    constructor(runtime: AgentRuntime, chunkSize = 1000, chunkOverlap = 200) {
        this.runtime = runtime;
        this.chunkSize = chunkSize;
        this.chunkOverlap = chunkOverlap;
    }

    /**
     * Process uploaded file and create embeddings
     */
    async processFile(filePath: string, originalName: string, contentType: string, roomId: string): Promise<void> {
        try {
            elizaLogger.info(`🔍 Processing file: ${originalName} (${contentType})`);
            
            // 1. Parse file based on content type
            const text = await this.parseFile(filePath, contentType);
            
            if (!text || text.trim().length === 0) {
                elizaLogger.warn(`⚠️ No text extracted from file: ${originalName}`);
                return;
            }

            elizaLogger.info(`📝 Extracted ${text.length} characters from ${originalName}`);

            // 2. Chunk the text
            const chunks = this.chunkText(text, originalName, contentType);
            elizaLogger.info(`📦 Created ${chunks.length} chunks from ${originalName}`);

            // 3. Create embeddings and store each chunk
            for (const chunk of chunks) {
                await this.storeChunk(chunk, roomId);
            }

            elizaLogger.info(`✅ Successfully processed and stored ${chunks.length} chunks from ${originalName}`);
        } catch (error) {
            elizaLogger.error(`❌ Error processing file ${originalName}:`, error);
            throw error;
        }
    }

    /**
     * Parse file content based on type
     */
    async parseFile(filePath: string, contentType: string): Promise<string> {
        try {
            switch (contentType) {
                case 'application/pdf':
                    return await this.parsePDF(filePath);
                case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                    return await this.parseDocx(filePath);
                case 'application/msword':
                    elizaLogger.warn(`🚫 .doc files not supported, please convert to .docx: ${contentType}`);
                    return '';
                case 'text/plain':
                case 'text/csv':
                case 'application/json':
                    return await this.parseTextFile(filePath);
                case 'text/markdown':
                case 'text/x-markdown':
                    return await this.parseTextFile(filePath);
                default:
                    elizaLogger.warn(`🚫 Unsupported file type: ${contentType}`);
                    return '';
            }
        } catch (error) {
            elizaLogger.error(`❌ Error parsing file: ${filePath}`, error);
            throw error;
        }
    }

    /**
     * Parse DOCX file using mammoth
     */
    private async parseDocx(filePath: string): Promise<string> {
        try {
            const result = await mammoth.extractRawText({ path: filePath });
            
            if (result.messages && result.messages.length > 0) {
                elizaLogger.warn(`⚠️ DOCX parsing warnings for ${filePath}:`, result.messages);
            }
            
            return result.value || '';
        } catch (error) {
            elizaLogger.error(`❌ Error parsing DOCX: ${filePath}`, error);
            throw error;
        }
    }

    /**
     * Parse PDF file using pdfjs-dist with dynamic import
     */
    private async parsePDF(filePath: string): Promise<string> {
        try {
            // Use legacy build for Node.js as recommended by pdfjs-dist
            const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
            const { getDocument } = pdfjs;

            const dataBuffer = fs.readFileSync(filePath);
            // Convert Buffer to Uint8Array
            const uint8Array = new Uint8Array(dataBuffer);

            const pdf = await getDocument({ data: uint8Array }).promise;
            const numPages = pdf.numPages;
            const textPages: string[] = [];

            for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();
                const pageText = textContent.items
                    .filter(this.isTextItem)
                    .map((item: TextItem) => item.str)
                    .join(' ');
                textPages.push(pageText);
            }

            return textPages.join('\n');
        } catch (error) {
            elizaLogger.error(`❌ Error parsing PDF: ${filePath}`, error);
            throw error;
        }
    }

    /**
     * Parse text-based files
     */
    private async parseTextFile(filePath: string): Promise<string> {
        try {
            return fs.readFileSync(filePath, 'utf-8');
        } catch (error) {
            elizaLogger.error(`❌ Error reading text file: ${filePath}`, error);
            throw error;
        }
    }

    /**
     * Chunk text into smaller segments with overlap
     */
    private chunkText(text: string, fileName: string, contentType: string): DocumentChunk[] {
        const chunks: DocumentChunk[] = [];
        const paragraphs = text.split(/\n\s*\n/);
        
        let currentChunk = '';
        let chunkIndex = 0;
        
        for (const paragraph of paragraphs) {
            const proposedChunk = currentChunk + (currentChunk ? '\n\n' : '') + paragraph;
            
            if (proposedChunk.length <= this.chunkSize) {
                currentChunk = proposedChunk;
            } else {
                // Current chunk is full, save it
                if (currentChunk.trim()) {
                    chunks.push(this.createChunk(currentChunk, fileName, contentType, chunkIndex));
                    chunkIndex++;
                }
                
                // Start new chunk with overlap from previous chunk
                const overlapText = this.getOverlapText(currentChunk);
                currentChunk = overlapText + (overlapText ? '\n\n' : '') + paragraph;
                
                // If single paragraph is too long, split it by sentences
                if (currentChunk.length > this.chunkSize) {
                    const sentences = currentChunk.split(/(?<=[.!?])\s+/);
                    let sentenceChunk = overlapText;
                    
                    for (const sentence of sentences) {
                        const proposedSentenceChunk = sentenceChunk + (sentenceChunk ? ' ' : '') + sentence;
                        
                        if (proposedSentenceChunk.length <= this.chunkSize) {
                            sentenceChunk = proposedSentenceChunk;
                        } else {
                            if (sentenceChunk.trim()) {
                                chunks.push(this.createChunk(sentenceChunk, fileName, contentType, chunkIndex));
                                chunkIndex++;
                            }
                            sentenceChunk = sentence;
                        }
                    }
                    currentChunk = sentenceChunk;
                }
            }
        }
        
        // Add the last chunk
        if (currentChunk.trim()) {
            chunks.push(this.createChunk(currentChunk, fileName, contentType, chunkIndex));
        }
        
        // Update total chunks count
        chunks.forEach(chunk => {
            chunk.metadata.totalChunks = chunks.length;
        });
        
        return chunks;
    }

    /**
     * Get overlap text from the end of current chunk
     */
    private getOverlapText(text: string): string {
        if (text.length <= this.chunkOverlap) {
            return text;
        }
        
        const overlapStart = text.length - this.chunkOverlap;
        const overlapText = text.substring(overlapStart);
        
        // Try to break at sentence boundary
        const lastSentence = overlapText.lastIndexOf('. ');
        if (lastSentence > this.chunkOverlap / 2) {
            return overlapText.substring(lastSentence + 2);
        }
        
        return overlapText;
    }

    /**
     * Create a document chunk
     */
    private createChunk(text: string, fileName: string, contentType: string, chunkIndex: number): DocumentChunk {
        return {
            id: stringToUuid(`${fileName}-chunk-${chunkIndex}-${Date.now()}`),
            text: text.trim(),
            metadata: {
                source: 'file_upload',
                fileName,
                chunkIndex,
                totalChunks: 0, // Will be updated later
                contentType
            }
        };
    }

    /**
     * Store chunk as a memory with embedding
     */
    private async storeChunk(chunk: DocumentChunk, roomId: string): Promise<void> {
        try {
            const memory: Memory = {
                id: stringToUuid(chunk.id) as UUID,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId: stringToUuid(roomId) as UUID,
                content: {
                    text: chunk.text,
                    source: 'file_upload',
                    metadata: chunk.metadata
                },
                createdAt: Date.now(),
            };

            // Generate embedding and store
            await this.runtime.messageManager.addEmbeddingToMemory(memory);
            await this.runtime.messageManager.createMemory(memory);
            
            elizaLogger.info(`📝 Stored chunk ${chunk.metadata.chunkIndex + 1}/${chunk.metadata.totalChunks} from ${chunk.metadata.fileName}`);
        } catch (error) {
            elizaLogger.error(`❌ Error storing chunk:`, error);
            throw error;
        }
    }

    /**
     * Search for relevant chunks based on query
     */
    async searchChunks(query: string, roomId: string, limit = 5): Promise<Memory[]> {
        try {
            const queryEmbedding = await embed(this.runtime, query);
            const memories = await this.runtime.messageManager.searchMemoriesByEmbedding(
                queryEmbedding,
                {
                    roomId: stringToUuid(roomId) as UUID,
                    count: limit,
                    match_threshold: 0.7
                }
            );

            // Filter for file upload memories
            return memories.filter(memory => {
                const content = memory.content as any;
                return content.source === 'file_upload' && 
                       content.metadata?.source === 'file_upload';
            });
        } catch (error) {
            elizaLogger.error(`❌ Error searching chunks:`, error);
            return [];
        }
    }

    /**
     * Type guard function to check if the input is a TextItem
     */
    private isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
        return 'str' in item;
    }
}