# @elizaos/plugin-prediction

An AI-powered prediction plugin for ElizaOS that analyzes recent message actions, user behavior patterns, and contextual information to make intelligent predictions about future events, user actions, and conversation outcomes.

## Overview

The Prediction Plugin enables AI agents to analyze conversation patterns, user behaviors, message actions, and contextual data to generate intelligent predictions. It uses advanced pattern recognition, behavioral analysis, and machine learning techniques to forecast likely outcomes, user responses, and future conversation directions.

## Features

- **Behavioral Pattern Analysis**: Analyzes user message patterns, response times, and interaction styles
- **Action Sequence Prediction**: Predicts likely next actions based on recent message actions
- **Conversation Flow Forecasting**: Anticipates conversation direction and topic evolution
- **User Intent Prediction**: Identifies likely user intentions and goals
- **Engagement Level Forecasting**: Predicts user engagement and participation levels
- **Context-Aware Predictions**: Integrates knowledge base, facts, and historical data
- **Multi-Modal Analysis**: Considers text patterns, timing, frequency, and interaction types
- **Confidence Scoring**: Provides confidence levels for all predictions
- **Trend Detection**: Identifies emerging patterns and behavioral shifts

## Installation

```bash
npm install @elizaos/plugin-prediction
```

## Usage

### Basic Integration

```typescript
import { predictionPlugin } from "@elizaos/plugin-prediction";

// Add to your agent's plugins
const agent = {
    plugins: [predictionPlugin],
    // ... other configuration
};
```

### Character Configuration

Add the plugin to your character file:

```json
{
    "plugins": ["@elizaos/plugin-prediction"],
    // ... other character settings
}
```

## Actions

### PREDICT Action

The main action that generates predictions based on recent message actions and behavioral patterns.

**Trigger Words:**
- "predict"
- "forecast" 
- "anticipate"
- "what will happen"
- "what's next"
- "future"
- "likely outcome"
- "expect"
- "projection"

**Example Usage:**

```
User: "Can you predict what might happen next in our conversation?"

Agent: "**🔮 Prediction Analysis**

**Behavioral Patterns Detected:**
- High engagement level (8/10)
- Technical discussion preference
- Question-driven interaction style
- 3-minute average response time

**Likely Next Actions:**
1. **Follow-up Questions** (85% confidence)
   - You'll likely ask for more specific details
   - Technical implementation questions expected

2. **Topic Expansion** (72% confidence)
   - Discussion may shift to related technologies
   - Practical application examples requested

3. **Engagement Continuation** (91% confidence)
   - Conversation will continue for 5-8 more exchanges
   - Maintained interest in current topic

**Conversation Flow Prediction:**
- Next 2-3 messages: Technical deep-dive
- Following phase: Practical applications
- Likely conclusion: Action items or next steps

**Confidence Level**: High (82% overall accuracy)"
```

## Prediction Types

The plugin generates several types of predictions:

### 1. **User Action Predictions**
- Next likely message type (question, statement, request)
- Response timing patterns
- Engagement level changes
- Topic preferences

### 2. **Conversation Flow Predictions**
- Topic evolution and shifts
- Discussion depth and duration
- Natural conclusion points
- Branching conversation paths

### 3. **Behavioral Predictions**
- User interaction patterns
- Response style preferences
- Engagement sustainability
- Communication preferences

### 4. **Intent Predictions**
- Underlying user goals
- Information seeking patterns
- Decision-making indicators
- Action-oriented requests

### 5. **Contextual Predictions**
- Environmental factors impact
- Time-based behavior patterns
- Situational influences
- External trigger responses

## Evaluators

### Behavior Pattern Evaluator
Continuously analyzes user behavior patterns and updates prediction models.

### Message Action Evaluator  
Tracks and categorizes message actions to build action sequence models.

### Engagement Level Evaluator
Monitors user engagement levels and predicts engagement changes.

## Providers

### Pattern Analysis Provider
Provides behavioral pattern analysis and trend detection.

### Action Sequence Provider
Supplies action sequence data and transition probabilities.

### Context Prediction Provider
Delivers contextual information for enhanced prediction accuracy.

### Timing Analysis Provider
Analyzes temporal patterns in user behavior and message timing.

## Configuration

### Memory Tables

The plugin uses the following memory tables:

- `behavior_patterns`: Stores user behavior patterns and trends
- `action_sequences`: Records message action sequences and transitions
- `predictions`: Stores generated predictions and their outcomes
- `engagement_levels`: Tracks user engagement patterns over time

### Model Configuration

The action uses the `LARGE` model class by default for complex pattern analysis and prediction generation.

## API Reference

### predictionAction

The main action object with the following properties:

- **name**: `"PREDICT"`
- **similes**: Array of alternative trigger words
- **description**: Detailed description of prediction capabilities
- **validate**: Function to check if prediction is possible
- **handler**: Core prediction logic
- **examples**: Sample prediction scenarios

### Prediction Response Format

```typescript
interface PredictionResponse {
    predictions: {
        userActions: ActionPrediction[];
        conversationFlow: FlowPrediction[];
        behavioralChanges: BehaviorPrediction[];
        intentAnalysis: IntentPrediction[];
    };
    confidence: {
        overall: number;
        individual: number[];
    };
    patterns: {
        detected: Pattern[];
        emerging: Pattern[];
    };
    metadata: {
        analysisDepth: string;
        dataPoints: number;
        timeframe: string;
    };
}
```

## Advanced Features

### Pattern Recognition
- Message timing analysis
- Response length patterns
- Topic preference mapping
- Interaction style classification

### Behavioral Modeling
- User engagement scoring
- Conversation sustainability metrics
- Response predictability analysis
- Communication style adaptation

### Contextual Integration
- Knowledge base correlation
- Historical conversation analysis
- External factor consideration
- Multi-session pattern tracking

## Testing

Run the test suite:

```bash
npm test
```

The plugin includes comprehensive tests covering:

- Prediction accuracy validation
- Pattern recognition algorithms
- Behavioral analysis functions
- Integration with memory systems
- Edge case handling

## Contributing

Contributions are welcome! Please ensure:

1. All tests pass
2. Code follows the project's style guidelines
3. New prediction models include validation
4. Documentation is updated for any API changes

## License

This plugin is part of the ElizaOS ecosystem and follows the same licensing terms.

## Support

For issues, questions, or contributions, please refer to the main ElizaOS repository or documentation.
