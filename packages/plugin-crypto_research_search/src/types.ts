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
};


export type SearchResponse = {
    answer?: string;
    query: string;
    responseTime: number;
    images: SearchImage[];
    results: SearchResult[];
};

export interface SearchOptions {
    maxResults?: number;
    type?: "news" | "general";
    includeAnswer?: boolean;
    searchDepth?: "basic" | "advanced";
    topic?: "news" | "general";
    days?: number;
    includeRawContent?: boolean;
}
