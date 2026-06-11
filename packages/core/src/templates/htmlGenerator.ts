import type { Memory } from "../types.ts";

/**
 * Create HTML content for comprehensive analysis with professional styling
 * @param cryptoName Name of the cryptocurrency
 * @param cryptoSymbol Symbol of the cryptocurrency
 * @param currentDate Current date
 * @param analysisContent Generated analysis content
 * @param originalQuery Original user query
 * @param actionResults Action results from processing
 * @returns HTML content string
 */
export function createComprehensiveAnalysisHTML(
    cryptoName: string,
    cryptoSymbol: string,
    currentDate: string,
    analysisContent: string,
    originalQuery: string,
    actionResults: Memory[],
    language?: string
): string {
    // Convert markdown-style content to HTML
    const htmlAnalysisContent = convertMarkdownToHTML(analysisContent);
    
    return `<!DOCTYPE html>
<html lang="${language === "zh-CN" ? "zh-CN" : "en"}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Comprehensive ${cryptoName} Analysis - ${currentDate}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 15px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
            color: white;
            padding: 40px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/></pattern></defs><rect width="100" height="100" fill="url(%23grid)"/></svg>');
            opacity: 0.3;
        }
        
        .header-content {
            position: relative;
            z-index: 1;
        }
        
        .crypto-symbol {
            display: inline-block;
            background: rgba(255,255,255,0.2);
            padding: 8px 16px;
            border-radius: 25px;
            font-size: 14px;
            margin-bottom: 10px;
            backdrop-filter: blur(10px);
        }
        
        .main-title {
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 300;
        }
        
        .subtitle {
            font-size: 1.2em;
            opacity: 0.9;
            margin-bottom: 20px;
        }
        
        .analysis-meta {
            background: rgba(255,255,255,0.1);
            padding: 15px 25px;
            border-radius: 10px;
            display: inline-block;
            backdrop-filter: blur(10px);
        }
        
        .content {
            padding: 40px;
        }
        
        .query-section {
            background: #f8f9fa;
            border-left: 4px solid #3498db;
            padding: 20px;
            margin-bottom: 30px;
            border-radius: 0 8px 8px 0;
        }
        
        .query-section h3 {
            color: #2c3e50;
            margin-bottom: 10px;
            font-size: 1.1em;
        }
        
        .query-text {
            font-style: italic;
            color: #5a6c7d;
            background: white;
            padding: 15px;
            border-radius: 5px;
            border: 1px solid #e1e8ed;
        }
        
        .analysis-content {
            background: #fff;
            border-radius: 10px;
            padding: 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.05);
        }
        
        .analysis-content h1,
        .analysis-content h2,
        .analysis-content h3,
        .analysis-content h4 {
            color: #2c3e50;
            margin-top: 30px;
            margin-bottom: 15px;
        }
        
        .analysis-content h1 {
            font-size: 2em;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
        }
        
        .analysis-content h2 {
            font-size: 1.5em;
            color: #34495e;
        }
        
        .analysis-content h3 {
            font-size: 1.3em;
            color: #5a6c7d;
        }
        
        .analysis-content h4 {
            font-size: 1.1em;
            color: #7f8c8d;
        }
        
        .analysis-content p {
            margin-bottom: 15px;
            text-align: justify;
        }
        
        .analysis-content ul,
        .analysis-content ol {
            margin: 15px 0;
            padding-left: 30px;
        }
        
        .analysis-content li {
            margin-bottom: 8px;
        }
        
        .analysis-content strong {
            color: #2c3e50;
            font-weight: 600;
        }
        
        .highlight-box {
            background: linear-gradient(135deg, #74b9ff 0%, #0984e3 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        
        .warning-box {
            background: linear-gradient(135deg, #fdcb6e 0%, #e17055 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        
        .success-box {
            background: linear-gradient(135deg, #55a3ff 0%, #003d82 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        
        .footer {
            background: #2c3e50;
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .footer-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        
        .footer-section h4 {
            margin-bottom: 10px;
            color: #3498db;
        }
        
        .disclaimer {
            background: rgba(255,255,255,0.1);
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
            font-size: 0.9em;
            line-height: 1.4;
        }
        
        .generated-info {
            text-align: right;
            color: #7f8c8d;
            font-size: 0.9em;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #e1e8ed;
        }
        
        @media (max-width: 768px) {
            body {
                padding: 10px;
            }
            
            .header {
                padding: 20px;
            }
            
            .main-title {
                font-size: 1.8em;
            }
            
            .content {
                padding: 20px;
            }
            
            .analysis-content {
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-content">
                <div class="crypto-symbol">${cryptoSymbol}</div>
                <h1 class="main-title">Comprehensive ${cryptoName} Analysis</h1>
                <p class="subtitle">Professional Cryptocurrency Investment Research Report</p>
                <div class="analysis-meta">
                    <strong>Analysis Date:</strong> ${currentDate} | 
                    <strong>Generated by:</strong> SentiEdge AI Assistant
                </div>
            </div>
        </div>
        
        <div class="content">
            <div class="query-section">
                <h3>🎯 Analysis Request</h3>
                <div class="query-text">${originalQuery}</div>
            </div>
            
            <div class="analysis-content">
                ${htmlAnalysisContent}
            </div>
            
            <div class="generated-info">
                Report generated on ${new Date().toLocaleString()} | 
                File: ${cryptoSymbol}_comprehensive_analysis_${new Date().toISOString().replace(/[:.]/g, '-')}.html
            </div>
        </div>
        
        <div class="footer">
            <div class="footer-grid">
                <div class="footer-section">
                    <h4>Analysis Methodology</h4>
                    <p>This report uses advanced AI analysis combined with real-time market data, technical indicators, and fundamental analysis principles.</p>
                </div>
                <div class="footer-section">
                    <h4>Data Sources</h4>
                    <p>Multiple cryptocurrency exchanges, blockchain analytics platforms, news sources, and social sentiment indicators.</p>
                </div>
                <div class="footer-section">
                    <h4>Risk Management</h4>
                    <p>All investment recommendations include appropriate risk assessments and portfolio allocation guidelines.</p>
                </div>
            </div>
            
            <div class="disclaimer">
                <strong>⚠️ Important Disclaimer:</strong> This analysis is for informational and educational purposes only and should not be considered as financial advice. Cryptocurrency investments are highly volatile and risky. Always conduct your own research and consult with qualified financial advisors before making investment decisions. Past performance does not guarantee future results. Never invest more than you can afford to lose.
            </div>
        </div>
    </div>
</body>
</html>`;
}

/**
 * Convert markdown-style content to HTML
 * @param markdown Markdown content to convert
 * @returns HTML content
 */
function convertMarkdownToHTML(markdown: string): string {
    return markdown
        // Strip the executive-summary marker block — it's a machine-readable
        // duplicate of the visible "Executive Summary" section, only used by
        // the UI extractor; rendering it would either show a stray paragraph
        // (when comment-stripping isn't perfect) or duplicate the summary.
        .replace(/<!--\s*EXEC_SUMMARY_START\s*-->[\s\S]*?<!--\s*EXEC_SUMMARY_END\s*-->\s*/i, "")
        // Headers
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/^#### (.*$)/gim, '<h4>$1</h4>')
        
        // Bold and italic
        .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
        .replace(/\*(.*)\*/gim, '<em>$1</em>')
        
        // Lists (basic conversion)
        .replace(/^\* (.*$)/gim, '<li>$1</li>')
        .replace(/^- (.*$)/gim, '<li>$1</li>')
        .replace(/^\d+\. (.*$)/gim, '<li>$1</li>')
        
        // Wrap consecutive list items in ul tags
        .replace(/(<li>.*<\/li>)/gs, (match) => {
            return '<ul>' + match + '</ul>';
        })
        
        // Fix nested ul tags
        .replace(/<\/ul>\s*<ul>/g, '')
        
        // Paragraphs (split by double line breaks)
        .split('\n\n')
        .map(paragraph => {
            paragraph = paragraph.trim();
            if (!paragraph) return '';
            if (paragraph.startsWith('<h') || paragraph.startsWith('<ul') || paragraph.startsWith('<li')) {
                return paragraph;
            }
            return `<p>${paragraph.replace(/\n/g, '<br>')}</p>`;
        })
        .join('\n');
} 