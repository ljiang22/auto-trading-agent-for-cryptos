# Batch Update Guide for Remaining Actions

## 剩余需要更新的 Actions

### Code-Only Actions (还需完成6个)

#### 1. get_inflow_outflow.ts
**导入**: 添加 `generateActionSummary`
**Summary生成位置**: 在 createActionResponse 之前
```typescript
const actionSummary = generateActionSummary({
    actionName: 'Inflow/Outflow',
    assets: [symbol],
    timePeriod: `${timeRange} hours`,
    dataPoints: inflowOutflowData.data.length,
    additionalInfo: `net flow ${netFlow > 0 ? '+' : ''}${netFlow.toFixed(2)} ${symbol}`
});
// 在 actionData 中添加: summary: actionSummary
```

#### 2. get_transaction_volume.ts
**导入**: 添加 `generateActionSummary`
```typescript
const actionSummary = generateActionSummary({
    actionName: 'Transaction Volume',
    assets: [symbol],
    timePeriod: `${timeRange} hours`,
    dataPoints: volumeData.data.length,
    additionalInfo: `total volume $${totalVolume.toFixed(2)}M`
});
```

#### 3. get_addressandtransaction.ts
**导入**: 添加 `generateActionSummary`
```typescript
const actionSummary = generateActionSummary({
    actionName: 'Address & Transaction Data',
    assets: [symbol],
    timePeriod: `${days} days`,
    dataPoints: addressData.data.length,
    additionalInfo: `${activeAddresses} active addresses`
});
```

#### 4. get_fear_index.ts (plugin-charts)
**导入**: 添加 `generateActionSummary`
```typescript
const actionSummary = generateActionSummary({
    actionName: 'Fear & Greed Index',
    assets: ['Crypto Market'],
    timePeriod: 'current',
    dataPoints: 1,
    additionalInfo: `index value ${currentValue}/100 (${sentiment})`
});
```

#### 5. detailed_fear_index.ts (plugin-charts)
**导入**: 添加 `generateActionSummary`
```typescript
const actionSummary = generateActionSummary({
    actionName: 'Detailed Fear & Greed Index',
    assets: ['Crypto Market'],
    timePeriod: `${historicalData.length} days`,
    dataPoints: historicalData.length,
    additionalInfo: 'trend analysis with chart'
});
```

#### 6. image.ts (plugin-charts)
**导入**: 添加 `generateActionSummary`
```typescript
const actionSummary = generateActionSummary({
    actionName: 'Image Generation',
    assets: ['Visual'],
    timePeriod: 'on-demand',
    dataPoints: 1,
    additionalInfo: `${imageType} created`
});
```

---

### LLM Actions (还需完成7个)

所有LLM actions需要：
1. **添加导入**: `generateActionSummary`
2. **添加模板指令**: 在模板开头添加
3. **提取summary**: 使用正则提取或fallback
4. **清理文本**: 移除summary tags
5. **添加到actionData**: `summary: actionSummary`

#### LLM Template Instructions (添加到所有LLM模板开头)
```
**IMPORTANT: Action Summary Generation**
Before providing your analysis, you MUST generate a brief action summary:

[ACTION_SUMMARY]
<Action Name> for <ASSET> over <TIME_PERIOD> (<DATA_POINTS> data points): <KEY_INSIGHT>
[/ACTION_SUMMARY]

Example:
[ACTION_SUMMARY]
Market Prediction for BTC over 30 days (90 data points): bullish outlook with high confidence.
[/ACTION_SUMMARY]
```

#### LLM Summary Extraction Pattern
```typescript
// Extract summary from LLM response
let actionSummary = '';
const summaryMatch = analysis.match(/\[ACTION_SUMMARY\](.*?)\[\/ACTION_SUMMARY\]/s);
if (summaryMatch) {
    actionSummary = summaryMatch[1].trim().replace(/^(Action|<Action Name>):\s*/i, '');
} else {
    // Fallback
    actionSummary = generateActionSummary({
        actionName: '<Action Name>',
        assets: [asset],
        timePeriod: `${dataLength} periods`,
        dataPoints: dataLength,
        additionalInfo: '<key context>'
    });
}

// Remove summary tags from display text
const cleanedAnalysis = analysis.replace(/\[ACTION_SUMMARY\].*?\[\/ACTION_SUMMARY\]/s, '').trim();
```

#### 1. prediction.ts
- Template: Add summary instructions to prediction template
- Fallback context: prediction timeframe, confidence level

#### 2. fearandgreed_index_analysis.ts
- Template: Add to fear/greed analysis template
- Fallback context: current sentiment level, trend direction

#### 3. generalContentAnalysis.ts
- Template: Add to `getGeneralContentAnalysisTemplate()`
- Fallback context: content type, analysis scope

#### 4. cryptoContentAnalysis.ts
- Template: Add to crypto content template
- Fallback context: crypto asset, content source

#### 5. crypto_research.ts
- Template: Add to research analysis template
- Fallback context: number of articles, research scope

#### 6. institutional_adoption webSearch.ts
- Template: Add to institutional analysis template
- Fallback context: institutions tracked, adoption events

#### 7. web-search webSearch.ts
- Template: Add to search analysis template
- Fallback context: search results count, search scope

---

## Pattern Summary

### For Code-Only Actions:
1. Import: `generateActionSummary`
2. Generate summary before callback
3. Add to `actionData: { ...existingData, summary: actionSummary }`

### For LLM Actions:
1. Import: `generateActionSummary`
2. Add template instructions
3. Extract summary with regex (with fallback)
4. Clean analysis text
5. Add to `actionData: { summary: actionSummary, ...existingData }`
