/**
 * TextChunker - Utility for splitting large text into embeddable chunks
 *
 * Used by ActionCacheManager to chunk action results before embedding.
 * Maintains semantic coherence by splitting on paragraph/sentence boundaries.
 */

export interface ChunkOptions {
    /** Maximum characters per chunk (default: 200) */
    maxChunkSize?: number;
    /** Overlap between chunks in characters (default: 20, auto-calculated as 10% of maxChunkSize) */
    overlap?: number;
    /** Whether to preserve paragraph boundaries (default: true) */
    preserveParagraphs?: boolean;
}

export interface TextChunk {
    /** The chunk text content */
    text: string;
    /** Index of this chunk (0-based) */
    index: number;
    /** Total number of chunks */
    total: number;
    /** Start position in original text */
    startPos: number;
    /** End position in original text */
    endPos: number;
}

/**
 * Split text into chunks suitable for embedding
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
    const {
        maxChunkSize = 200,
        overlap = Math.floor((options.maxChunkSize || 200) * 0.1), // 10% of maxChunkSize
        preserveParagraphs = true,
    } = options;

    // If text is small enough, return as single chunk
    if (text.length <= maxChunkSize) {
        return [{
            text,
            index: 0,
            total: 1,
            startPos: 0,
            endPos: text.length,
        }];
    }

    const chunks: TextChunk[] = [];
    let currentPos = 0;

    while (currentPos < text.length) {
        let endPos = Math.min(currentPos + maxChunkSize, text.length);

        // Don't break in the middle of content - find a good break point
        if (endPos < text.length) {
            endPos = findBreakPoint(text, currentPos, endPos, preserveParagraphs);
        }

        const chunkText = text.slice(currentPos, endPos).trim();

        if (chunkText.length > 0) {
            chunks.push({
                text: chunkText,
                index: chunks.length,
                total: 0, // Will be updated after all chunks are created
                startPos: currentPos,
                endPos,
            });
        }

        // Move position, accounting for overlap
        currentPos = endPos - overlap;
        if (currentPos <= chunks[chunks.length - 1]?.startPos) {
            // Prevent infinite loop if overlap is too large
            currentPos = endPos;
        }
    }

    // Update total count for all chunks
    const total = chunks.length;
    for (const chunk of chunks) {
        chunk.total = total;
    }

    return chunks;
}

/**
 * Find a good break point in the text
 * Prefers paragraph breaks > sentence breaks > word breaks
 */
function findBreakPoint(
    text: string,
    startPos: number,
    maxPos: number,
    preserveParagraphs: boolean
): number {
    const searchText = text.slice(startPos, maxPos);

    // Try to find paragraph break (double newline)
    if (preserveParagraphs) {
        const paragraphBreak = searchText.lastIndexOf('\n\n');
        if (paragraphBreak > searchText.length * 0.5) {
            return startPos + paragraphBreak + 2;
        }
    }

    // Try to find sentence break
    const sentenceBreaks = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
    let bestBreak = -1;

    for (const breakStr of sentenceBreaks) {
        const pos = searchText.lastIndexOf(breakStr);
        if (pos > bestBreak && pos > searchText.length * 0.3) {
            bestBreak = pos + breakStr.length;
        }
    }

    if (bestBreak > 0) {
        return startPos + bestBreak;
    }

    // Try to find word break
    const wordBreak = searchText.lastIndexOf(' ');
    if (wordBreak > searchText.length * 0.5) {
        return startPos + wordBreak + 1;
    }

    // Fall back to max position
    return maxPos;
}

/**
 * Merge chunks back into original text
 * Useful for debugging/testing
 */
export function mergeChunks(chunks: TextChunk[]): string {
    if (chunks.length === 0) return '';
    if (chunks.length === 1) return chunks[0].text;

    // Sort by index
    const sorted = [...chunks].sort((a, b) => a.index - b.index);

    // Simple concatenation with newline separator
    return sorted.map(c => c.text).join('\n\n');
}

/**
 * Estimate the number of chunks for a given text length
 */
export function estimateChunkCount(
    textLength: number,
    maxChunkSize = 1000,
    overlap = 100
): number {
    if (textLength <= maxChunkSize) return 1;

    const effectiveChunkSize = maxChunkSize - overlap;
    return Math.ceil((textLength - overlap) / effectiveChunkSize);
}

/**
 * Create a summary prefix for chunked content
 * Useful for providing context in multi-chunk results
 */
export function createChunkHeader(chunk: TextChunk, actionName?: string): string {
    if (chunk.total === 1) {
        return actionName ? `[${actionName}]` : '';
    }

    const header = `[Part ${chunk.index + 1}/${chunk.total}]`;
    return actionName ? `[${actionName}] ${header}` : header;
}
