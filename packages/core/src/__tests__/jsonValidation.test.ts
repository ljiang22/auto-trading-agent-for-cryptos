import { describe, test, expect } from "vitest";
import { validateActionResponseFormat, createJsonCorrectionPrompt, detectsMalformedJsonIntent } from "../jsonValidation.ts";

describe("JSON Validation", () => {
    describe("validateActionResponseFormat", () => {
        test("should validate a correct action response", () => {
            const validJson = {
                is_crypto_related: true,
                analysis: "Test analysis",
                reasoning: "1. First step\n2. Second step",
                action: [
                    {
                        name: "GET_CRYPTO_PRICE",
                        target: "BTC",
                        parameters: { symbol: "BTC" }
                    }
                ],
                response: "Fetching Bitcoin price data",
                next_step: "Would you like a chart?"
            };

            const result = validateActionResponseFormat(validJson);
            
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.hasActions).toBe(true);
            expect(result.hasResponse).toBe(true);
        });

        test("should detect missing required response field", () => {
            const invalidJson = {
                is_crypto_related: true,
                analysis: "Test analysis",
                action: []
            };

            const result = validateActionResponseFormat(invalidJson);
            
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Missing required field: response");
            expect(result.missingFields).toContain("response");
        });

        test("should detect invalid action format", () => {
            const invalidJson = {
                response: "Test response",
                action: [
                    {
                        // Missing required 'name' field
                        target: "BTC",
                        parameters: { symbol: "BTC" }
                    }
                ]
            };

            const result = validateActionResponseFormat(invalidJson);
            
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Action[0] missing required 'name' field");
        });

        test("should handle empty action arrays", () => {
            const validJson = {
                response: "No actions needed",
                action: []
            };

            const result = validateActionResponseFormat(validJson);
            
            expect(result.isValid).toBe(false); // Missing response makes it invalid
            expect(result.hasActions).toBe(true); // Empty array still counts as having actions field
            expect(result.errors).toContain("Action array is empty");
        });

        test("should handle null/undefined input", () => {
            const result1 = validateActionResponseFormat(null);
            const result2 = validateActionResponseFormat(undefined);
            
            expect(result1.isValid).toBe(false);
            expect(result2.isValid).toBe(false);
            expect(result1.errors[0]).toContain("not an object");
            expect(result2.errors[0]).toContain("not an object");
        });
    });

    describe("createJsonCorrectionPrompt", () => {
        test("should create a correction prompt with all required sections", () => {
            const malformedResponse = '{"response": "test", "action": [missing bracket';
            const errors = ["JSON parsing error: Unexpected end of input"];
            const originalPrompt = "What is Bitcoin price?";

            const prompt = createJsonCorrectionPrompt(malformedResponse, errors, originalPrompt);

            expect(prompt).toContain("JSON FORMAT CORRECTION REQUIRED");
            expect(prompt).toContain(originalPrompt);
            expect(prompt).toContain(malformedResponse);
            expect(prompt).toContain(errors[0]);
            expect(prompt).toContain("REQUIRED JSON FORMAT");
            expect(prompt).toContain("CRITICAL REQUIREMENTS");
        });
    });

    describe("detectsMalformedJsonIntent", () => {
        test("should detect JSON intent in responses with json code blocks", () => {
            const response = "```json\n{\"response\": \"test\"}";
            expect(detectsMalformedJsonIntent(response)).toBe(true);
        });

        test("should detect JSON intent in responses starting with {", () => {
            const response = "   {\n  \"response\": \"test\"";
            expect(detectsMalformedJsonIntent(response)).toBe(true);
        });

        test("should detect JSON intent with action fields", () => {
            const response = 'Here is my response: "action": [';
            expect(detectsMalformedJsonIntent(response)).toBe(true);
        });

        test("should not detect JSON intent in plain text", () => {
            const response = "This is just a plain text response without any JSON indicators.";
            expect(detectsMalformedJsonIntent(response)).toBe(false);
        });

        test("should detect JSON intent with crypto related fields", () => {
            const response = 'Analysis shows "is_crypto_related": true but the format is wrong';
            expect(detectsMalformedJsonIntent(response)).toBe(true);
        });
    });
});