export type SearchResult = {
    title: string;
    url: string;
    content: string;
    rawContent?: string;
    score: number;
    publishedDate?: string;
};

export type SearchImage = {
    url: string;
    description?: string;
    iterationFound?: number;
};


export type SearchResponse = {
    answer?: string;
    query: string;
    responseTime: number;
    images: SearchImage[];
    results: SearchResult[];
};

export interface SearchOptions {
    limit?: number;
    type?: "news" | "general";
    includeAnswer?: boolean;
    searchDepth?: "basic" | "advanced";
    topic?: string;
    includeImages?: boolean;
    days?: number; // 1 means current day, 2 means last 2 days
}
