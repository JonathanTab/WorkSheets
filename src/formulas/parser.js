/**
 * Formula Parser
 *
 * Parses spreadsheet formula strings into an Abstract Syntax Tree (AST).
 * Supports:
 * - Cell references (A1, $B$2, Sheet1!A1)
 * - Ranges (A1:B10)
 * - Numbers and strings
 * - Arithmetic operators (+, -, *, /, ^, %)
 * - Comparison operators (=, <>, <, >, <=, >=)
 * - Function calls (SUM, AVERAGE, IF, etc.)
 * - Parentheses for grouping
 */

// Token types
const TokenType = {
    NUMBER: 'NUMBER',
    STRING: 'STRING',
    CELL_REF: 'CELL_REF',
    RANGE: 'RANGE',
    FUNCTION: 'FUNCTION',
    OPERATOR: 'OPERATOR',
    LPAREN: 'LPAREN',
    RPAREN: 'RPAREN',
    COMMA: 'COMMA',
    COLON: 'COLON',
    SHEET_REF: 'SHEET_REF',
    EOF: 'EOF'
};

// AST Node types
export const NodeType = {
    NUMBER: 'Number',
    STRING: 'String',
    CELL_REF: 'CellRef',
    RANGE: 'Range',
    BINARY_OP: 'BinaryOp',
    UNARY_OP: 'UnaryOp',
    FUNCTION_CALL: 'FunctionCall',
    SHEET_REF: 'SheetRef'
};

/**
 * Tokenizer class
 */
class Tokenizer {
    constructor(input) {
        this.input = input;
        this.pos = 0;
        this.currentChar = input[0];
    }

    advance() {
        this.pos++;
        this.currentChar = this.pos < this.input.length ? this.input[this.pos] : null;
    }

    peek(offset = 1) {
        const peekPos = this.pos + offset;
        return peekPos < this.input.length ? this.input[peekPos] : null;
    }

    skipWhitespace() {
        while (this.currentChar && /\s/.test(this.currentChar)) {
            this.advance();
        }
    }

    readNumber() {
        let result = '';
        let hasDecimal = false;

        while (this.currentChar && (/\d/.test(this.currentChar) || this.currentChar === '.')) {
            if (this.currentChar === '.') {
                if (hasDecimal) break;
                hasDecimal = true;
            }
            result += this.currentChar;
            this.advance();
        }

        return { type: TokenType.NUMBER, value: parseFloat(result) };
    }

    readString(quoteChar) {
        this.advance(); // Skip opening quote
        let result = '';

        while (this.currentChar && this.currentChar !== quoteChar) {
            if (this.currentChar === '\\' && this.peek() === quoteChar) {
                this.advance(); // Skip escape character
            }
            result += this.currentChar;
            this.advance();
        }

        if (this.currentChar === quoteChar) {
            this.advance(); // Skip closing quote
        }

        return { type: TokenType.STRING, value: result };
    }

    readIdentifier() {
        let result = '';

        while (this.currentChar && /[a-zA-Z0-9_$]/.test(this.currentChar)) {
            result += this.currentChar;
            this.advance();
        }

        // Check if it's a function (followed by parenthesis)
        if (this.currentChar === '(') {
            return { type: TokenType.FUNCTION, value: result.toUpperCase() };
        }

        // Check if it's a sheet reference (followed by !)
        if (this.currentChar === '!') {
            this.advance(); // Skip !
            return { type: TokenType.SHEET_REF, value: result };
        }

        // Otherwise it's a cell reference
        return { type: TokenType.CELL_REF, value: result.toUpperCase() };
    }

    tokenize() {
        const tokens = [];

        while (this.currentChar) {
            this.skipWhitespace();

            if (!this.currentChar) break;

            const char = this.currentChar;

            if (/\d/.test(char) || (char === '.' && /\d/.test(this.peek()))) {
                tokens.push(this.readNumber());
            } else if (char === '"' || char === "'") {
                tokens.push(this.readString(char));
            } else if (/[a-zA-Z_]/.test(char)) {
                tokens.push(this.readIdentifier());
            } else if (char === '$') {
                // Absolute reference - read the rest
                this.advance();
                let result = '$';
                while (this.currentChar && /[a-zA-Z0-9]/.test(this.currentChar)) {
                    result += this.currentChar;
                    this.advance();
                }
                // Check for sheet reference
                if (this.currentChar === '!') {
                    this.advance();
                    tokens.push({ type: TokenType.SHEET_REF, value: result });
                } else {
                    tokens.push({ type: TokenType.CELL_REF, value: result.toUpperCase() });
                }
            } else if (char === '+') {
                tokens.push({ type: TokenType.OPERATOR, value: '+' });
                this.advance();
            } else if (char === '-') {
                tokens.push({ type: TokenType.OPERATOR, value: '-' });
                this.advance();
            } else if (char === '*') {
                tokens.push({ type: TokenType.OPERATOR, value: '*' });
                this.advance();
            } else if (char === '/') {
                tokens.push({ type: TokenType.OPERATOR, value: '/' });
                this.advance();
            } else if (char === '^') {
                tokens.push({ type: TokenType.OPERATOR, value: '^' });
                this.advance();
            } else if (char === '%') {
                tokens.push({ type: TokenType.OPERATOR, value: '%' });
                this.advance();
            } else if (char === '=') {
                tokens.push({ type: TokenType.OPERATOR, value: '=' });
                this.advance();
            } else if (char === '<') {
                if (this.peek() === '>') {
                    tokens.push({ type: TokenType.OPERATOR, value: '<>' });
                    this.advance();
                    this.advance();
                } else if (this.peek() === '=') {
                    tokens.push({ type: TokenType.OPERATOR, value: '<=' });
                    this.advance();
                    this.advance();
                } else {
                    tokens.push({ type: TokenType.OPERATOR, value: '<' });
                    this.advance();
                }
            } else if (char === '>') {
                if (this.peek() === '=') {
                    tokens.push({ type: TokenType.OPERATOR, value: '>=' });
                    this.advance();
                    this.advance();
                } else {
                    tokens.push({ type: TokenType.OPERATOR, value: '>' });
                    this.advance();
                }
            } else if (char === '(') {
                tokens.push({ type: TokenType.LPAREN, value: '(' });
                this.advance();
            } else if (char === ')') {
                tokens.push({ type: TokenType.RPAREN, value: ')' });
                this.advance();
            } else if (char === ',') {
                tokens.push({ type: TokenType.COMMA, value: ',' });
                this.advance();
            } else if (char === ':') {
                tokens.push({ type: TokenType.COLON, value: ':' });
                this.advance();
            } else {
                throw new Error(`Unexpected character: ${char}`);
            }
        }

        tokens.push({ type: TokenType.EOF, value: null });
        return tokens;
    }
}

/**
 * Parser class - Recursive descent parser
 */
export class Parser {
    constructor(input) {
        const tokenizer = new Tokenizer(input);
        this.tokens = tokenizer.tokenize();
        this.pos = 0;
        this.currentToken = this.tokens[0];
    }

    advance() {
        this.pos++;
        this.currentToken = this.pos < this.tokens.length ? this.tokens[this.pos] : null;
    }

    peek(offset = 1) {
        const peekPos = this.pos + offset;
        return peekPos < this.tokens.length ? this.tokens[peekPos] : null;
    }

    expect(tokenType) {
        if (this.currentToken?.type !== tokenType) {
            throw new Error(`Expected ${tokenType}, got ${this.currentToken?.type}`);
        }
        const token = this.currentToken;
        this.advance();
        return token;
    }

    /**
     * Parse the formula and return AST
     */
    parse() {
        if (this.currentToken?.type === TokenType.EOF) {
            return null;
        }

        const ast = this.parseExpression();

        if (this.currentToken?.type !== TokenType.EOF) {
            throw new Error('Unexpected token after expression');
        }

        return ast;
    }

    /**
     * Expression with comparison operators (lowest precedence)
     */
    parseExpression() {
        let left = this.parseAdditive();

        while (this.currentToken?.type === TokenType.OPERATOR &&
            ['=', '<>', '<', '>', '<=', '>='].includes(this.currentToken.value)) {
            const op = this.currentToken.value;
            this.advance();
            const right = this.parseAdditive();
            left = { type: NodeType.BINARY_OP, op, left, right };
        }

        return left;
    }

    /**
     * Addition and subtraction
     */
    parseAdditive() {
        let left = this.parseMultiplicative();

        while (this.currentToken?.type === TokenType.OPERATOR &&
            ['+', '-'].includes(this.currentToken.value)) {
            const op = this.currentToken.value;
            this.advance();
            const right = this.parseMultiplicative();
            left = { type: NodeType.BINARY_OP, op, left, right };
        }

        return left;
    }

    /**
     * Multiplication, division
     */
    parseMultiplicative() {
        let left = this.parsePower();

        while (this.currentToken?.type === TokenType.OPERATOR &&
            ['*', '/'].includes(this.currentToken.value)) {
            const op = this.currentToken.value;
            this.advance();
            const right = this.parsePower();
            left = { type: NodeType.BINARY_OP, op, left, right };
        }

        return left;
    }

    /**
     * Exponentiation
     */
    parsePower() {
        let left = this.parsePercent();

        while (this.currentToken?.type === TokenType.OPERATOR &&
            this.currentToken.value === '^') {
            const op = this.currentToken.value;
            this.advance();
            const right = this.parsePercent();
            left = { type: NodeType.BINARY_OP, op, left, right };
        }

        return left;
    }

    /**
     * Percent (unary postfix)
     */
    parsePercent() {
        let node = this.parseUnary();

        while (this.currentToken?.type === TokenType.OPERATOR &&
            this.currentToken.value === '%') {
            this.advance();
            node = { type: NodeType.UNARY_OP, op: '%', operand: node };
        }

        return node;
    }

    /**
     * Unary operators (+, -)
     */
    parseUnary() {
        if (this.currentToken?.type === TokenType.OPERATOR &&
            ['+', '-'].includes(this.currentToken.value)) {
            const op = this.currentToken.value;
            this.advance();
            const operand = this.parseUnary();
            return { type: NodeType.UNARY_OP, op, operand };
        }

        return this.parsePrimary();
    }

    /**
     * Primary expressions (numbers, strings, cell refs, functions, parentheses)
     */
    parsePrimary() {
        const token = this.currentToken;

        if (!token || token.type === TokenType.EOF) {
            throw new Error('Unexpected end of expression');
        }

        // Number
        if (token.type === TokenType.NUMBER) {
            this.advance();
            return { type: NodeType.NUMBER, value: token.value };
        }

        // String
        if (token.type === TokenType.STRING) {
            this.advance();
            return { type: NodeType.STRING, value: token.value };
        }

        // Sheet reference
        if (token.type === TokenType.SHEET_REF) {
            const sheetName = token.value;
            this.advance();

            // Next should be a cell reference or range
            if (this.currentToken?.type === TokenType.CELL_REF) {
                const cellRef = this.parseCellOrRange();
                return {
                    type: NodeType.SHEET_REF,
                    sheet: sheetName,
                    ref: cellRef
                };
            }

            throw new Error(`Expected cell reference after sheet name ${sheetName}`);
        }

        // Cell reference (may be followed by : for range)
        if (token.type === TokenType.CELL_REF) {
            return this.parseCellOrRange();
        }

        // Function call
        if (token.type === TokenType.FUNCTION) {
            return this.parseFunctionCall(token.value);
        }

        // Parenthesized expression
        if (token.type === TokenType.LPAREN) {
            this.advance();
            const expr = this.parseExpression();
            this.expect(TokenType.RPAREN);
            return expr;
        }

        throw new Error(`Unexpected token: ${token.type} (${token.value})`);
    }

    /**
     * Parse cell reference or range
     */
    parseCellOrRange() {
        const cellRef = this.parseCellRef();

        // Check for range
        if (this.currentToken?.type === TokenType.COLON) {
            this.advance();
            const endRef = this.parseCellRef();
            return {
                type: NodeType.RANGE,
                start: cellRef,
                end: endRef
            };
        }

        return cellRef;
    }

    /**
     * Parse cell reference (e.g., A1, $B$2)
     */
    parseCellRef() {
        const token = this.expect(TokenType.CELL_REF);
        const value = token.value;

        // Parse the cell reference
        const match = value.match(/^(\$?)([A-Z]+)(\$?)(\d+)$/);
        if (!match) {
            throw new Error(`Invalid cell reference: ${value}`);
        }

        const [, colAbs, col, rowAbs, row] = match;
        const colNum = this.columnToNumber(col);

        return {
            type: NodeType.CELL_REF,
            col: colNum - 1, // 0-indexed
            row: parseInt(row) - 1, // 0-indexed
            colAbsolute: colAbs === '$',
            rowAbsolute: rowAbs === '$',
            ref: value
        };
    }

    /**
     * Parse function call
     */
    parseFunctionCall(name) {
        this.advance(); // Skip function name
        this.expect(TokenType.LPAREN);

        const args = [];

        if (this.currentToken?.type !== TokenType.RPAREN) {
            args.push(this.parseExpression());

            while (this.currentToken?.type === TokenType.COMMA) {
                this.advance();
                args.push(this.parseExpression());
            }
        }

        this.expect(TokenType.RPAREN);

        return {
            type: NodeType.FUNCTION_CALL,
            name,
            args
        };
    }

    /**
     * Convert column letter(s) to number (A=1, B=2, ..., Z=26, AA=27, etc.)
     */
    columnToNumber(col) {
        let result = 0;
        for (let i = 0; i < col.length; i++) {
            result = result * 26 + (col.charCodeAt(i) - 64);
        }
        return result;
    }
}

/**
 * Parse a formula string and return AST
 * @param {string} formula - The formula string (with or without leading =)
 * @returns {Object|null} - AST or null if empty
 */
export function parseFormula(formula) {
    if (!formula || typeof formula !== 'string') {
        return null;
    }

    // Remove leading = if present
    const input = formula.startsWith('=') ? formula.slice(1) : formula;

    if (!input.trim()) {
        return null;
    }

    const parser = new Parser(input);
    return parser.parse();
}

/**
 * Extract all cell references from an AST
 * @param {Object} ast - The AST
 * @returns {Array<{row: number, col: number}>} - Array of cell references
 */
export function extractCellRefs(ast) {
    const refs = [];

    function visit(node) {
        if (!node) return;

        switch (node.type) {
            case NodeType.CELL_REF:
                refs.push({ row: node.row, col: node.col });
                break;

            case NodeType.RANGE:
                // Add all cells in the range
                for (let r = node.start.row; r <= node.end.row; r++) {
                    for (let c = node.start.col; c <= node.end.col; c++) {
                        refs.push({ row: r, col: c });
                    }
                }
                break;

            case NodeType.BINARY_OP:
            case NodeType.UNARY_OP:
                visit(node.left);
                visit(node.right);
                visit(node.operand);
                break;

            case NodeType.FUNCTION_CALL:
                node.args.forEach(visit);
                break;

            case NodeType.SHEET_REF:
                visit(node.ref);
                break;
        }
    }

    visit(ast);
    return refs;
}

export default parseFormula;
