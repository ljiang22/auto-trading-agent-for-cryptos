import { describe, expect, it } from "vitest";
import { extractReportMetadata } from "../src/utils/reportMetadataExtractor.ts";

describe("extractReportMetadata", () => {
    it("builds a native price chart spec from structured action data", () => {
        const metadata = extractReportMetadata(
            [
                {
                    content: {
                        action: "plot_price_charts",
                        metadata: {
                            chartPath: "saved_data/Charts/Price Chart BTC 2026-03-10.html",
                            actionData: {
                                cryptoSymbol: "BTC",
                                chartData: {
                                    labels: ["2026-03-08", "2026-03-09", "2026-03-10"],
                                    priceData: [82000, 83500, 84200],
                                    volumeData: [1500, 1625, 1710],
                                },
                            },
                        },
                    },
                } as any,
            ],
            "BTC",
            "2026-03-10"
        );

        expect(metadata.charts).toHaveLength(1);
        expect(metadata.charts[0].chartSpec?.labels).toEqual([
            "2026-03-08",
            "2026-03-09",
            "2026-03-10",
        ]);
        expect(metadata.charts[0].chartSpec?.datasets).toHaveLength(2);
        expect(metadata.charts[0].chartSpec?.axes?.y?.format).toBe("currency");
    });

    it("builds a native sentiment chart spec from sentiment analysis data", () => {
        const metadata = extractReportMetadata(
            [
                {
                    content: {
                        action: "Sentiment_Analysis",
                        metadata: {
                            chartPath: "saved_data/Charts/Sentiment Chart BTC 2026-03-10.html",
                            actionData: {
                                sentimentData: {
                                    xScores: [
                                        { time: "2026-03-09T10:00:00Z", value: 0.4 },
                                        { time: "2026-03-10T10:00:00Z", value: 0.2 },
                                    ],
                                    newsScores: [
                                        { time: "2026-03-09T12:00:00Z", value: 0.1 },
                                        { time: "2026-03-10T12:00:00Z", value: -0.2 },
                                    ],
                                },
                            },
                        },
                    },
                } as any,
            ],
            "BTC",
            "2026-03-10"
        );

        expect(metadata.charts).toHaveLength(1);
        expect(metadata.charts[0].chartSpec?.labels).toEqual([
            "2026-03-09",
            "2026-03-10",
        ]);
        expect(metadata.charts[0].chartSpec?.datasets.map((dataset) => dataset.label)).toEqual([
            "X Sentiment",
            "News Sentiment",
        ]);
        expect(metadata.charts[0].chartSpec?.datasets[0].data).toEqual([0.4, 0.2]);
        expect(metadata.charts[0].chartSpec?.datasets[1].data).toEqual([0.1, -0.2]);
    });

    it("weights sentiment scores by sample size so low-sample hours don't dominate the daily value", () => {
        const metadata = extractReportMetadata(
            [
                {
                    content: {
                        action: "Sentiment_Analysis",
                        metadata: {
                            actionData: {
                                sentimentData: {
                                    xScores: [
                                        // Same day, three hours with very different sample sizes.
                                        // Without weighting the simple mean would be (0.5+1.0-1.0)/3 = 0.167
                                        // With total-weighting it's (0.5*200 + 1.0*1 + -1.0*1)/(200+1+1) = ~0.495
                                        { time: "2026-03-09T08:00:00Z", value: 0.5, total: 200 },
                                        { time: "2026-03-09T09:00:00Z", value: 1.0, total: 1 },
                                        { time: "2026-03-09T10:00:00Z", value: -1.0, total: 1 },
                                    ],
                                    newsScores: [],
                                },
                            },
                        },
                    },
                } as any,
            ],
            "BTC",
            "2026-03-10"
        );

        expect(metadata.charts[0].chartSpec?.labels).toEqual(["2026-03-09"]);
        expect(metadata.charts[0].chartSpec?.datasets[0].data).toEqual([0.495]);
    });

    it("trims sentiment charts to the last 7 days for future reports", () => {
        const makeScores = (prefix: string) =>
            Array.from({ length: 10 }, (_, index) => ({
                time: Math.floor(Date.parse(`2026-03-${String(index + 1).padStart(2, "0")}T12:00:00Z`) / 1000),
                value: Number((index / 10).toFixed(2)),
                source: prefix,
            }));

        const metadata = extractReportMetadata(
            [
                {
                    content: {
                        action: "Sentiment_Analysis",
                        metadata: {
                            actionData: {
                                sentimentData: {
                                    xScores: makeScores("x"),
                                    newsScores: makeScores("news"),
                                },
                            },
                        },
                    },
                } as any,
            ],
            "BTC",
            "2026-03-10"
        );

        expect(metadata.charts[0].chartSpec?.labels).toEqual([
            "2026-03-04",
            "2026-03-05",
            "2026-03-06",
            "2026-03-07",
            "2026-03-08",
            "2026-03-09",
            "2026-03-10",
        ]);
        expect(metadata.charts[0].chartSpec?.datasets.map((dataset) => dataset.data)).toEqual([
            [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
            [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
        ]);
    });

    it("trims inflow/outflow charts to the last 7 days for future reports", () => {
        const labels = [
            "Mar 1", "Mar 1",
            "Mar 2", "Mar 2",
            "Mar 3", "Mar 3",
            "Mar 4", "Mar 4",
            "Mar 5", "Mar 5",
            "Mar 6", "Mar 6",
            "Mar 7", "Mar 7",
            "Mar 8", "Mar 8",
            "Mar 9", "Mar 9",
        ];

        const metadata = extractReportMetadata(
            [
                {
                    content: {
                        action: "INFLOW_OUTFLOW_ANALYSIS",
                        actionData: {
                            content: {
                                visualizations: {
                                    chart_data: {
                                        labels,
                                        inflowData: labels.map((_, index) => index + 1),
                                        outflowData: labels.map((_, index) => index + 101),
                                        liquidityData: labels.map((_, index) => index + 201),
                                    },
                                },
                            },
                        },
                    },
                } as any,
            ],
            "BTC",
            "2026-03-10"
        );

        expect(metadata.charts[0].chartSpec?.labels).toEqual([
            "Mar 3", "Mar 3",
            "Mar 4", "Mar 4",
            "Mar 5", "Mar 5",
            "Mar 6", "Mar 6",
            "Mar 7", "Mar 7",
            "Mar 8", "Mar 8",
            "Mar 9", "Mar 9",
        ]);
        expect(metadata.charts[0].chartSpec?.datasets.map((dataset) => dataset.data.length)).toEqual([14, 14, 14]);
    });
});
