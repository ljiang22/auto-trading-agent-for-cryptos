interface KeyState {
    key: string;
    exhaustedUntil: number | null;
}

class TavilyKeyManager {
    private keys: KeyState[];

    constructor() {
        const raw: string[] = [];
        for (let i = 1; i <= 10; i++) {
            const k = process.env[`TAVILY_API_KEY_${i}`];
            if (k?.trim()) raw.push(k.trim());
        }
        if (raw.length === 0 && process.env.TAVILY_API_KEY?.trim()) {
            raw.push(process.env.TAVILY_API_KEY.trim());
        }
        if (raw.length === 0) {
            console.warn("[TavilyKeyManager] No Tavily API keys configured");
        }
        this.keys = raw.map(key => ({ key, exhaustedUntil: null }));
    }

    getActiveKey(): string | null {
        const now = Date.now();
        for (const state of this.keys) {
            if (state.exhaustedUntil === null || state.exhaustedUntil <= now) {
                state.exhaustedUntil = null;
                return state.key;
            }
        }
        return null;
    }

    markExhausted(key: string): void {
        const state = this.keys.find(k => k.key === key);
        if (state) {
            state.exhaustedUntil = Date.now() + 60 * 60 * 1000;
        }
        console.warn(`[TavilyKeyManager] Key ...${key.slice(-6)} quota exhausted — cooldown 1h`);
        this._logStatus();
    }

    markRateLimited(key: string): void {
        const state = this.keys.find(k => k.key === key);
        if (state) {
            state.exhaustedUntil = Date.now() + 60 * 1000;
        }
        console.warn(`[TavilyKeyManager] Key ...${key.slice(-6)} rate-limited — cooldown 60s`);
    }

    get keyCount(): number {
        return this.keys.length;
    }

    private _logStatus(): void {
        const now = Date.now();
        const available = this.keys.filter(k => !k.exhaustedUntil || k.exhaustedUntil <= now).length;
        console.log(`[TavilyKeyManager] ${available}/${this.keys.length} keys available`);
    }
}

export const tavilyKeyManager = new TavilyKeyManager();
