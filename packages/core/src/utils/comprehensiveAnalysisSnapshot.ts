import type { Memory } from "../core/types.ts";

/**
 * Interface for comprehensive analysis snapshot data structure
 * This matches the ComprehensiveActionResult interface used by the frontend
 */
export interface ComprehensiveActionResult {
    action: string;
    phase: string;
    status: 'success' | 'failed' | 'pending';
    content: string;
    summary?: string;
    message?: {
        id: string;
        text: string;
        createdAt: number;
        source?: string;
        attachments?: any[];
        metadata?: any;
        error?: any;
    };
}

export interface ComprehensiveAnalysisSnapshot {
    actionResults: ComprehensiveActionResult[];
    actionsByPhase: Record<string, ComprehensiveActionResult[]>;
    progressInfo: {
        currentPhase: string;
        overallProgress: number;
        completedActions: number;
        totalExpectedActions: number;
    };
    title: string;
    createdAt: number;
}

/**
 * Generates a comprehensive analysis snapshot for historical tab display
 * This snapshot contains all the data needed to recreate the interactive tabs
 * when viewing historical comprehensive analysis conversations
 */
export function generateComprehensiveAnalysisSnapshot(actionResults: Memory[]): ComprehensiveAnalysisSnapshot {
    // Helper function to extract action name from content
    const getActionNameFromContent = (result: Memory, index: number): string => {
        const metadata = (result.content?.metadata as any) || {};
        const text = result.content?.text || '';
        
        if (metadata.actionName) return metadata.actionName;
        
        // Extract from message text for different analysis types
        if (text.includes('CRYPTOCURRENCY SENTIMENT ANALYSIS')) return 'Sentiment Analysis';
        if (text.includes('Fear & Greed Index')) return 'Fear & Greed Analysis';
        if (text.includes('Cryptocurrency Research Analysis')) return 'Research Analysis';
        if (text.includes('Transaction Count Chart')) return 'Transaction Analysis';
        if (text.includes('Inflow/Outflow')) return 'Flow Analysis';
        if (text.includes('Technic Analysis') || text.includes('Technical Analysis')) return 'Technical Analysis';
        if (text.includes('Price Chart')) return 'Price Analysis';
        if (text.includes('Crypto Market Prediction')) return 'Prediction Analysis';
        if (text.includes('Latest') && text.includes('data')) return 'Data Collection';
        if (text.includes('GET_CRYPTO_PRICE')) return 'Price Data';
        if (text.includes('getnews')) return 'News Analysis';
        if (text.includes('WHALE_ALERT')) return 'Whale Monitoring';
        if (text.includes('web_search')) return 'Web Research';
        if (text.includes('CRYPTO_RESEARCH_SEARCH')) return 'Research Search';
        if (text.includes('plot_charts')) return 'Chart Generation';
        
        return `Analysis ${index + 1}`;
    };

    // Helper function to extract phase from content
    const getPhaseFromContent = (result: Memory): string => {
        const metadata = (result.content?.metadata as any) || {};
        const text = result.content?.text || '';
        
        if (metadata.phase) return metadata.phase;
        
        // Extract phase from message content
        if (text.includes('Downloaded') || text.includes('Latest') || text.includes('data is from')) return 'data_gathering';
        if (text.includes('GET_CRYPTO_PRICE') || text.includes('getnews') || text.includes('WHALE_ALERT') || 
            text.includes('web_search') || text.includes('CRYPTO_RESEARCH_SEARCH') || text.includes('plot_charts')) return 'data_gathering';
        if (text.includes('CRYPTOCURRENCY SENTIMENT ANALYSIS') || text.includes('TECHNICAL_ANALYSIS') || 
            text.includes('FEAR_GREED_INDEX_ANALYSIS') || text.includes('INFLOW_OUTFLOW_ANALYSIS') || 
            text.includes('GET_ADDRESS_AND_TRANSACTION_DATA')) return 'analysis';
        if (text.includes('Chart') || text.includes('generated')) return 'chart_generation';
        if (text.includes('Prediction') || text.includes('PREDICTION') || text.includes('Market')) return 'prediction';
        if (text.includes('Report Generation') || text.includes('writing_report')) return 'writing_report';
        
        return 'analysis'; // Default to analysis phase
    };

    // Transform actionResults into ComprehensiveActionResult format
    const snapshotActionResults: ComprehensiveActionResult[] = actionResults.map((result, index) => {
        const metadata = (result.content?.metadata as any) || {};
        const actionName = getActionNameFromContent(result, index);
        const phase = getPhaseFromContent(result);
        
        // Determine status
        let status: 'success' | 'failed' | 'pending' = 'success'; // Default to success for completed analysis
        if (metadata.success !== undefined) {
            status = metadata.success ? 'success' : 'failed';
        } else if (result.content?.error) {
            status = 'failed';
        } else if (result.content?.text && (
            result.content.text.includes('successfully') || 
            result.content.text.includes('generated') || 
            result.content.text.includes('complete') ||
            result.content.text.includes('Analysis complete')
        )) {
            status = 'success';
        }

        // Don't lie about failed actions in the summary line; surface the
        // error reason (if any) so users see *why* an action didn't run.
        const defaultSummary =
            status === 'failed'
                ? (metadata.error || result.content?.error || `${actionName} failed`)
                : `${actionName} completed successfully`;

        return {
            action: actionName,
            phase: phase,
            status: status,
            content: result.content?.text || '',
            summary: metadata.summary || String(defaultSummary),
            message: {
                id: String(result.id || `snapshot-msg-${index}`),
                text: result.content?.text || '',
                createdAt: result.createdAt || Date.now(),
                source: result.content?.source,
                attachments: result.content?.attachments,
                metadata: metadata,
                error: result.content?.error
            }
        };
    });

    // Group actions by phase
    const actionsByPhase: Record<string, ComprehensiveActionResult[]> = {};
    snapshotActionResults.forEach(action => {
        const phase = action.phase || 'other';
        if (!actionsByPhase[phase]) {
            actionsByPhase[phase] = [];
        }
        actionsByPhase[phase].push(action);
    });

    // Calculate progress info based on the expected comprehensive analysis structure
    const EXPECTED_ACTIONS = {
        // Must match COMPREHENSIVE_ANALYSIS_ACTIONS phases in
        // comprehensiveAnalysisWorkflowGraph.ts
        data_gathering: 7,
        analysis: 4,
        prediction: 1,
        writing_report: 1,
    };

    const totalExpectedActions = Object.values(EXPECTED_ACTIONS).reduce((sum, count) => sum + count, 0);
    // `actionResults` already includes the synthetic Report Generation row
    // (appended by saveReport) and any failed action rows (added in
    // executeActions' failure branches), so just count successes directly.
    // The previous `+1` hack double-counted the report when it was present
    // and inflated `completedActions` past the actual successful count when
    // a tool had silently failed (e.g. 12 success + 1 failed -> reported 13).
    const completedActions = Math.min(
        totalExpectedActions,
        snapshotActionResults.filter((a) => a.status === "success").length,
    );
    
    // For completed analysis, set progress to 100%
    const progressInfo = {
        currentPhase: 'writing_report',
        overallProgress: 1.0, // 100% complete since this is generated at completion
        completedActions: completedActions,
        totalExpectedActions: totalExpectedActions
    };

    return {
        actionResults: snapshotActionResults,
        actionsByPhase: actionsByPhase,
        progressInfo: progressInfo,
        title: "Comprehensive Analysis",
        createdAt: Date.now()
    };
}

/**
 * Checks if a memory object contains comprehensive analysis data
 */
export function isComprehensiveAnalysisMemory(memory: Memory): boolean {
    const source = memory.content?.source;
    return source === 'comprehensive_analysis';
}

/**
 * Extracts comprehensive analysis memories from a list of memories
 */
export function extractComprehensiveAnalysisMemories(memories: Memory[]): Memory[] {
    return memories.filter(isComprehensiveAnalysisMemory);
}