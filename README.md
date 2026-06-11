# Senti-Agent 🤖

<div align="center">
  <img src="./docs/static/img/eliza_banner.jpg" alt="Senti-Agent Banner" width="100%" />
</div>

<div align="center">

📑 [Website](https://sentiedge.ai/) |  📖 [Agent](https://agent.sentiedge.ai/) | 🎯 [FAQ](https://agent.sentiedge.ai/faq)

</div>

## 🎯 Use Cases

- 🤖 Chatbots
- 🕵️ Autonomous Agents
- 📈 Business Process Handling
- 🧠 Trading

## 🚀 Quick Start

### Prerequisites
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

> **Note for Windows Users:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required.

### Manually Start Senti-Agent (Only recommended for plugin or platform development)

#### Edit the .env file

Copy .env.example to .env and fill in the appropriate values.

```
cp .env.example .env
```

Note: .env is optional. If you're planning to run multiple distinct agents, you can pass secrets through the character JSON

#### Start Senti-Agent

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start the agent
pnpm start

# Or start with debug logging
pnpm start:debug

# Clean start (removes database and starts fresh)
pnpm cleanstart

# Clean start with debug logging
pnpm cleanstart:debug

# Clean build artifacts (node_modules, dist, .turbo)
pnpm clean
```

#### Run local dev with MongoDB (instead of SQLite)

```bash
# Start MongoDB locally
docker run -d --name sentiedge-mongo -p 27017:27017 mongo:7

# Configure .env
DATABASE_ADAPTER=mongodb
MONGODB_CONNECTION_STRING=mongodb://127.0.0.1:27017
MONGODB_DATABASE=elizaAgent

# Start agent and client
pnpm start
pnpm start:client
```

You should see startup logs confirming Mongo adapter selection and successful Mongo connection.

### Interact via Browser

Once the agent is running, you should see the message to run "pnpm start:client" at the end.

Open another terminal, move to the same directory, run the command below, then follow the URL to chat with your agent.

```bash
pnpm start:client
```

---

## 📜 Available Scripts

### Installation & Setup
- `pnpm install` - Install all workspace dependencies (enforces pnpm usage)
- `pnpm build` - Build all packages using Turbo pipeline
- `pnpm build-docker` - Build all packages including docs for Docker

### Running the Agent
- `pnpm start` - Start the agent locally with workspace context
- `pnpm start:client` - Start the Vite client dashboard
- `pnpm start:debug` - Start agent with debug logging enabled
- `pnpm cleanstart` - Remove database and start fresh
- `pnpm cleanstart:debug` - Remove database and start fresh with debug logging

### Development
- `pnpm dev` - Run combined developer workflow (builds, watches, hot-reloads)
- `pnpm clean` - Clean build artifacts (node_modules, dist, .turbo, cache)

### Code Quality
- `pnpm format` - Format code using Biome
- `pnpm lint` - Lint code using Biome
- `pnpm check` - Run both format and lint checks with auto-fix

### Testing
- `pnpm test` - Run all unit tests
- `pnpm smokeTests` - Run smoke tests
- `pnpm integrationTests` - Run integration tests
- `pnpm test:streaming` - Run streaming tests
- `pnpm test:streaming:benchmark` - Run streaming benchmark tests
- `pnpm test:streaming:manual` - Run manual streaming tests

### Docker
- `pnpm docker:build` - Build the production agent image
- `pnpm docker:run` - Run the production agent image on port 3000 using `.env`
- `pnpm docker` - Build and run the production agent image

The root `Dockerfile` is now a production image for the agent only. It does not start the local Vite client, and it bakes in the Amazon DocumentDB CA bundle at `/app/global-bundle.pem` for `MONGODB_CONNECTION_STRING` TLS connections.

### PM2 Process Management
- `pnpm pm2:start` - Start agent with PM2
- `pnpm pm2:stop` - Stop PM2 process
- `pnpm pm2:restart` - Restart PM2 process
- `pnpm pm2:delete` - Delete PM2 process
- `pnpm pm2:logs` - View PM2 logs
- `pnpm pm2:status` - Check PM2 status

### Release
- `pnpm release` - Build, format, and publish packages using Lerna

---

### Development Workflow

For active development with hot-reloading:

```bash
# Runs the combined developer workflow (builds core, watches for changes, runs agent in dev mode)
pnpm dev
```

This script:
- Builds all packages first
- Watches core package for changes
- Runs the agent in development mode with nodemon
- Automatically restarts on file changes

> **Note**: For a complete list of all available scripts, see the [Available Scripts](#-available-scripts) section above.

---

## Using Your Custom Plugins
Plugins that are not in the official registry for Senti-Agent can be used as well. Here's how:

### Installation

1. Upload the custom plugin to the packages folder:

```
packages/
├─plugin-example/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts        # Main plugin entry
│   ├── actions/        # Custom actions
│   ├── providers/      # Data providers
│   ├── types.ts        # Type definitions
│   └── environment.ts  # Configuration
├── README.md
└── LICENSE
```
---

## 🛠️ System Requirements

### Minimum Requirements
- CPU: Dual-core processor
- RAM: 4GB
- Storage: 1GB free space
- Internet connection: Broadband (1 Mbps+)

### Software Requirements
- Node.js 23+
- pnpm
- Git

### Optional Requirements
- GPU: For running local LLM models
- Additional storage: For document storage and memory
- Higher RAM: For running multiple agents

## 📁 Project Structure
```
senti-agent/
├── packages/
│   ├── core/           # Core Senti-Agent functionality
│   ├── clients/        # Client implementations
│   └── actions/        # Custom actions
├── docs/              # Documentation
├── scripts/           # Utility scripts
└── examples/          # Example implementations
```

### Code Style
- Follow the existing code style
- Add comments for complex logic
- Update documentation for changes
- Add tests for new features

## 🖼️ Automatic Image Analysis

SentiEdge now includes automatic image analysis powered by Google's Gemini AI. When you upload an image through the chat interface, the system will automatically:

1. **Detect Image Upload**: Automatically recognizes when an image file is uploaded (supports PNG, JPEG, WebP, HEIC, HEIF)
2. **Trigger Analysis**: Automatically invokes the Gemini Image Analysis action without manual intervention
3. **Generate Dynamic Prompts**: Creates context-aware analysis prompts based on your message content
4. **Provide Insights**: Returns detailed analysis including:
   - Image description and content identification
   - Technical analysis for crypto charts and trading images
   - Market sentiment analysis for financial imagery
   - Text extraction and pattern recognition

### Features

- **Zero-Click Analysis**: No need to manually request image analysis - it happens automatically
- **Smart Prompt Generation**: Creates tailored analysis prompts based on your specific request
- **Crypto-Focused**: Specialized analysis for trading charts, market data, and crypto-related content
- **Real-time Streaming**: Results are streamed back immediately as they're generated
- **Memory Integration**: Analysis results are stored for future reference and context

### Usage

Simply upload an image in the chat interface and include your message. The system will:
- Process your image automatically
- Generate a contextual analysis prompt
- Provide detailed insights using Gemini 2.0 Flash
- Display results in a formatted, easy-to-read format

---


