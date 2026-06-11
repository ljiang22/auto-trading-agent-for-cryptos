import type { IAgentRuntime, Media, Memory, UUID } from "../core/types.ts";
import { elizaLogger } from "./logger.ts";
import { googleApplicationCredentialsFromSetting } from "./googleVertexCredentials.ts";
import { stringToUuid } from "./uuid.ts";
import { embed } from "../ai/embedding.ts";
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ImageAnalysisResult {
    analysis: string;
    base64Data: string;
    mimeType: string;
    filePath: string;
    fileName: string;
}

export class ImageProcessor {
    private runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }

    /**
     * Process uploaded image files and return enhanced Media objects with base64 data and analysis
     */
    async processImages(mediaAttachments: Media[], roomId: UUID, userId: UUID): Promise<Media[]> {
        const processedAttachments: Media[] = [];

        for (const attachment of mediaAttachments) {
            if (this.isImageFile(attachment)) {
                try {
                    const analysisResult = await this.analyzeImage(attachment.url, attachment.title);

                    // Store image and analysis in RAG system with actual room and user context
                    await this.storeImageInRAG(analysisResult, attachment.title, roomId, userId);

                    // Enhance the attachment with analysis and base64 data
                    const enhancedAttachment: Media = {
                        ...attachment,
                        base64Data: analysisResult.base64Data,
                        geminiAnalysis: analysisResult.analysis,
                        contentType: analysisResult.mimeType
                    };

                    processedAttachments.push(enhancedAttachment);
                    elizaLogger.info(`✅ Processed and stored image: ${attachment.title}`);
                } catch (error) {
                    elizaLogger.error(`❌ Error processing image ${attachment.title}:`, error);
                    // Keep original attachment without processing
                    processedAttachments.push(attachment);
                }
            } else {
                // Non-image attachments pass through unchanged
                processedAttachments.push(attachment);
            }
        }

        return processedAttachments;
    }

    /**
     * Analyze a single image file using Gemini AI
     */
    private async analyzeImage(imagePath: string, fileName: string): Promise<ImageAnalysisResult> {
        const project = this.runtime.getSetting("GOOGLE_VERTEX_PROJECT");
        const credentialsJson = this.runtime.getSetting("GOOGLE_APPLICATION_CREDENTIALS_JSON");
        if (!project) {
            throw new Error("GOOGLE_VERTEX_PROJECT not found in environment variables");
        }
        if (!credentialsJson) {
            throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON not found in environment variables");
        }

        const location = this.runtime.getSetting("GOOGLE_VERTEX_LOCATION") ?? "global";
        const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
        const google = createVertex({
            project,
            location,
            baseURL: `https://${host}/v1/projects/${project}/locations/${location}/publishers/google`,
            googleAuthOptions: {
                credentials: googleApplicationCredentialsFromSetting(credentialsJson),
            },
        });

        // Validate image exists
        if (!fs.existsSync(imagePath)) {
            throw new Error(`Image file not found: ${imagePath}`);
        }

        // Read image file as base64
        elizaLogger.info(`📸 Reading image from: ${imagePath}`);
        const base64ImageFile = fs.readFileSync(imagePath, {
            encoding: "base64",
        });

        // Determine MIME type based on file extension
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = this.getMimeType(ext);

        // Create concise analysis prompt (targeting ~250 tokens)
        const analysisPrompt = `Analyze this image and provide a concise summary in exactly 250 tokens or less:

1. **Type**: What kind of image is this? (chart, screenshot, document, photo, etc.)
2. **Subject**: What is the main content/topic?
3. **Key Details**: Most important information visible
4. **Context**: Any relevant background or setting

Be specific and factual. Focus on what's actually visible in the image.`;

        const modelName =
            this.runtime.getSetting("SMALL_GOOGLE_MODEL") ||
            this.runtime.getSetting("GOOGLE_MODEL") ||
            "gemini-2.5-flash";

        elizaLogger.info(`🤖 Sending image to ${modelName} via Vertex AI`);
        elizaLogger.info(`📸 Image file size: ${base64ImageFile.length} chars (base64)`);

        const { text: analysisResult } = await generateText({
            model: google(modelName),
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: analysisPrompt },
                        {
                            type: "image",
                            image: `data:${mimeType};base64,${base64ImageFile}`,
                        },
                    ],
                },
            ],
        });

        elizaLogger.info("✅ Gemini analysis completed successfully");
        elizaLogger.info(`📝 Response length: ${analysisResult.length} characters`);

        return {
            analysis: analysisResult,
            base64Data: base64ImageFile,
            mimeType,
            filePath: imagePath,
            fileName
        };
    }

    /**
     * Check if a media attachment is an image file
     */
    private isImageFile(attachment: Media): boolean {
        if (!attachment.url) return false;
        
        // Check by file extension
        const ext = path.extname(attachment.url).toLowerCase();
        const supportedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
        
        // Also check by contentType if available
        const isSupportedByExtension = supportedExtensions.includes(ext);
        const isSupportedByContentType = attachment.contentType?.startsWith('image/');
        
        return isSupportedByExtension || isSupportedByContentType;
    }

    /**
     * Get MIME type from file extension
     */
    private getMimeType(ext: string): string {
        switch (ext) {
            case ".png":
                return "image/png";
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".webp":
                return "image/webp";
            case ".heic":
                return "image/heic";
            case ".heif":
                return "image/heif";
            default:
                throw new Error(`Unsupported image format: ${ext}. Supported formats: PNG, JPEG, WebP, HEIC, HEIF`);
        }
    }

    /**
     * Create image content for LLM context (base64 data for current request)
     */
    static createImageContentForLLM(mediaAttachments: Media[]): Array<{ type: string; data: string; mimeType: string }> {
        return mediaAttachments
            .filter(attachment => attachment.base64Data)
            .map(attachment => ({
                type: 'image',
                data: attachment.base64Data!,
                mimeType: attachment.contentType || 'image/jpeg'
            }));
    }

    /**
     * Store image analysis and base64 data in RAG system
     */
    private async storeImageInRAG(analysisResult: ImageAnalysisResult, originalName: string, roomId: UUID, userId: UUID): Promise<void> {
        try {
            const memory: Memory = {
                id: stringToUuid(`image-${originalName}-${Date.now()}`),
                userId: userId,
                agentId: this.runtime.agentId,
                roomId: roomId,
                content: {
                    text: analysisResult.analysis,
                    source: 'image_upload',
                    metadata: {
                        source: 'image_upload',
                        fileName: originalName,
                        mimeType: analysisResult.mimeType,
                        base64Data: analysisResult.base64Data,
                        filePath: analysisResult.filePath,
                        processedAt: Date.now()
                    }
                },
                createdAt: Date.now(),
            };

            // Generate embedding and store
            await this.runtime.messageManager.addEmbeddingToMemory(memory);
            await this.runtime.messageManager.createMemory(memory);

            elizaLogger.info(`📝 Stored image analysis in room ${roomId} for user ${userId}: ${originalName}`);
        } catch (error) {
            elizaLogger.error(`❌ Error storing image in RAG:`, error);
            throw error;
        }
    }

    /**
     * Search for relevant images based on query and return with base64 data
     */
    async searchImages(query: string, roomId: string, limit = 3): Promise<Array<{analysis: string, base64Data: string, fileName: string, mimeType: string}>> {
        try {
            const queryEmbedding = await embed(this.runtime, query);
            const memories = await this.runtime.messageManager.searchMemoriesByEmbedding(
                queryEmbedding,
                {
                    roomId: stringToUuid("image-storage"),
                    count: limit,
                    match_threshold: 0.7
                }
            );

            // Filter for image memories and extract data
            return memories
                .filter(memory => {
                    const content = memory.content as any;
                    return content.source === 'image_upload' && 
                           content.metadata?.source === 'image_upload' &&
                           content.metadata?.base64Data;
                })
                .map(memory => {
                    const metadata = (memory.content as any).metadata;
                    return {
                        analysis: memory.content.text,
                        base64Data: metadata.base64Data,
                        fileName: metadata.fileName,
                        mimeType: metadata.mimeType
                    };
                });
        } catch (error) {
            elizaLogger.error(`❌ Error searching images:`, error);
            return [];
        }
    }

    /**
     * Format image analysis for message context
     */
    static formatImageAnalysisForContext(mediaAttachments: Media[]): string {
        const imageAnalyses = mediaAttachments
            .filter(attachment => attachment.geminiAnalysis)
            .map((attachment, index) => {
                return `## Image ${index + 1}: ${attachment.title}

${attachment.geminiAnalysis}`;
            })
            .join('\n\n');

        return imageAnalyses ? `\n\n## Uploaded Images Analysis\n\n${imageAnalyses}` : '';
    }
}