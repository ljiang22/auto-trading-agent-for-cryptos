// Debug test for written number recognition
function convertWrittenNumberToDigit(text) {
    const numberMap = {
        'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
        'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
        'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
        'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
        'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70,
        'eighty': 80, 'ninety': 90, 'hundred': 100, 'thousand': 1000
    };
    
    const lowerText = text.toLowerCase().trim();
    console.log(`Converting: "${lowerText}"`);
    
    // Handle simple cases first
    if (numberMap[lowerText] !== undefined) {
        console.log(`Found simple match: ${numberMap[lowerText]}`);
        return numberMap[lowerText];
    }
    
    // Handle compound numbers like "twenty-five", "thirty-two", etc.
    const compoundMatch = lowerText.match(/^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\s]?(one|two|three|four|five|six|seven|eight|nine)$/);
    if (compoundMatch) {
        const tens = numberMap[compoundMatch[1]];
        const ones = numberMap[compoundMatch[2]];
        console.log(`Found compound match: ${tens} + ${ones} = ${tens + ones}`);
        return tens + ones;
    }
    
    // Handle "X hundred" patterns
    const hundredMatch = lowerText.match(/^(one|two|three|four|five|six|seven|eight|nine)\s+hundred$/);
    if (hundredMatch) {
        const result = numberMap[hundredMatch[1]] * 100;
        console.log(`Found hundred match: ${result}`);
        return result;
    }
    
    console.log(`No match found for: "${lowerText}"`);
    return null;
}

// Test simple pattern matching
function testSimplePattern() {
    const text = "analyze three tweets about Bitcoin";
    const pattern = /(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:tweet|tweets)/i;
    const match = text.match(pattern);
    console.log(`\nTesting simple pattern on: "${text}"`);
    console.log(`Pattern: ${pattern}`);
    console.log(`Match result:`, match);
    if (match && match[1]) {
        const converted = convertWrittenNumberToDigit(match[1]);
        console.log(`Converted "${match[1]}" to: ${converted}`);
    }
}

// Test the conversion function directly
console.log('=== Testing convertWrittenNumberToDigit ===');
const testNumbers = ['two', 'three', 'four', 'ten', 'twenty', 'fifty'];
testNumbers.forEach(num => {
    const result = convertWrittenNumberToDigit(num);
    console.log(`"${num}" -> ${result}`);
});

console.log('\n=== Testing simple pattern matching ===');
testSimplePattern();

// Test a more complex case
console.log('\n=== Testing complex case ===');
const complexText = "get sentiment from recent twenty tweets";
console.log(`Testing: "${complexText}"`);

// Simple pattern for recent X tweets
const recentPattern = /recent\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+(?:tweet|tweets)/i;
const recentMatch = complexText.match(recentPattern);
console.log(`Recent pattern match:`, recentMatch);
if (recentMatch && recentMatch[1]) {
    const converted = convertWrittenNumberToDigit(recentMatch[1]);
    console.log(`Converted "${recentMatch[1]}" to: ${converted}`);
} 