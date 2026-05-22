/**
 * Formula Parser
 *
 * Parses spreadsheet formula strings into an Abstract Syntax Tree (AST).
 * Supports:
 * - Cell references (A1, $B$2, Sheet1!A1)
 * - Ranges (A1:B10)
 * - Numbers and strings
 * - Arithmetic operators (+, -, *, /, ^, %)
 * - Comparison operators (=, <>, <, >, <=, >=, CONTAINS)
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
    REP_VAR: 'REP_VAR',
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
    SHEET_REF: 'SheetRef',
    REP_VAR: 'RepVar'
};

/**
 * Tokenizer class
 *
 * Each token in the returned array carries `start` and `end` (exclusive) character
 * positions in the original input string. These positions are used by formulaParser.js
 * for formula-bar highlighting and ref-picking without duplicating lexical rules.
 */
export class Tokenizer {
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

        // Allow dots inside function names only when followed by a letter
        // e.g. WORKDAY.INTL, NETWORKDAYS.INTL
        while (this.currentChar === '.' && this.peek() && /[a-zA-Z_]/.test(this.peek())) {
            result += this.currentChar; // consume the dot
            this.advance();
            while (this.currentChar && /[a-zA-Z0-9_$]/.test(this.currentChar)) {
                result += this.currentChar;
                this.advance();
            }
        }

        // Keyword comparison operators (case-insensitive)
        const keyword = result.toLowerCase();
        if (keyword === 'contains') {
            return { type: TokenType.OPERATOR, value: keyword };
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
            const tokenStart = this.pos;

            if (/\d/.test(char) || (char === '.' && /\d/.test(this.peek()))) {
                const tok = this.readNumber();
                tokens.push({ ...tok, start: tokenStart, end: this.pos });
            } else if (char === '"') {
                const tok = this.readString(char);
                tokens.push({ ...tok, start: tokenStart, end: this.pos });
            } else if (char === "'") {
                // Single-quoted string OR quoted sheet name ('Sheet Name'!A1).
                this.advance(); // consume opening '
                let nameValue = '';
                while (this.currentChar) {
                    if (this.currentChar === "'") {
                        if (this.peek() === "'") {
                            nameValue += "'";
                            this.advance();
                            this.advance();
                        } else {
                            this.advance(); // consume closing '
                            break;
                        }
                    } else {
                        nameValue += this.currentChar;
                        this.advance();
                    }
                }
                if (this.currentChar === '!') {
                    this.advance(); // consume !
                    tokens.push({ type: TokenType.SHEET_REF, value: nameValue, start: tokenStart, end: this.pos });
                } else {
                    tokens.push({ type: TokenType.STRING, value: nameValue, start: tokenStart, end: this.pos });
                }
            } else if (/[a-zA-Z_]/.test(char)) {
                const tok = this.readIdentifier();
                tokens.push({ ...tok, start: tokenStart, end: this.pos });
            } else if (char === '$') {
                // Absolute reference OR $rep variable
                this.advance();
                let result = '$';
                while (this.currentChar && /[a-zA-Z0-9_]/.test(this.currentChar)) {
                    result += this.currentChar;
                    this.advance();
                }
                if (result.toLowerCase() === '$rep') {
                    tokens.push({ type: TokenType.REP_VAR, value: '$rep', start: tokenStart, end: this.pos });
                } else if (this.currentChar === '!') {
                    this.advance();
                    tokens.push({ type: TokenType.SHEET_REF, value: result, start: tokenStart, end: this.pos });
                } else {
                    tokens.push({ type: TokenType.CELL_REF, value: result.toUpperCase(), start: tokenStart, end: this.pos });
                }
            } else if (char === '+') {
                tokens.push({ type: TokenType.OPERATOR, value: '+', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === '-') {
                tokens.push({ type: TokenType.OPERATOR, value: '-', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === '*') {
                tokens.push({ type: TokenType.OPERATOR, value: '*', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === '/') {
                tokens.push({ type: TokenType.OPERATOR, value: '/', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === '^') {
                tokens.push({ type: TokenType.OPERATOR, value: '^', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === '%') {
                tokens.push({ type: TokenType.OPERATOR, value: '%', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === '&') {
                tokens.push({ type: TokenType.OPERATOR, value: '&', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === '=') {
                tokens.push({ type: TokenType.OPERATOR, value: '=', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === '<') {
                if (this.peek() === '>') {
                    tokens.push({ type: TokenType.OPERATOR, value: '<>', start: tokenStart, end: this.pos + 2 });
                    this.advance(); this.advance();
                } else if (this.peek() === '=') {
                    tokens.push({ type: TokenType.OPERATOR, value: '<=', start: tokenStart, end: this.pos + 2 });
                    this.advance(); this.advance();
                } else {
                    tokens.push({ type: TokenType.OPERATOR, value: '<', start: tokenStart, end: this.pos + 1 });
                    this.advance();
                }
            } else if (char === '>') {
                if (this.peek() === '=') {
                    tokens.push({ type: TokenType.OPERATOR, value: '>=', start: tokenStart, end: this.pos + 2 });
                    this.advance(); this.advance();
                } else {
                    tokens.push({ type: TokenType.OPERATOR, value: '>', start: tokenStart, end: this.pos + 1 });
                    this.advance();
                }
            } else if (char === '(') {
                tokens.push({ type: TokenType.LPAREN, value: '(', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === ')') {
                tokens.push({ type: TokenType.RPAREN, value: ')', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === ',') {
                tokens.push({ type: TokenType.COMMA, value: ',', start: tokenStart, end: this.pos + 1 });
                this.advance();
            } else if (char === ':') {
                tokens.push({ type: TokenType.COLON, value: ':', start: tokenStart, end: this.pos + 1 });
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
            ['=', '<>', '<', '>', '<=', '>=', 'contains'].includes(this.currentToken.value)) {
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
            ['+', '-', '&'].includes(this.currentToken.value)) {
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

        // $rep repetition variable
        if (token.type === TokenType.REP_VAR) {
            this.advance();
            return { type: NodeType.REP_VAR };
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
            // An empty arg (e.g. =IF(A1,1,) — trailing or double comma) is
            // treated as an explicit null node so optional arguments are cleanly
            // omitted rather than causing a parse error (Excel-compatible).
            // We use a dedicated MISSING type so evaluator can return undefined
            // (matching args.length behaviour that functions check with !== undefined).
            const MISSING = { type: 'Missing' };
            if (this.currentToken?.type === TokenType.COMMA) {
                args.push(MISSING);
            } else {
                args.push(this.parseExpression());
            }

            while (this.currentToken?.type === TokenType.COMMA) {
                this.advance();
                if (this.currentToken?.type === TokenType.RPAREN ||
                    this.currentToken?.type === TokenType.COMMA) {
                    args.push(MISSING);
                } else {
                    args.push(this.parseExpression());
                }
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
 * Extract all cell references and ranges from an AST.
 * Ranges are returned as descriptors rather than enumerating every cell,
 * so SUM(A1:A1000) produces one range entry rather than 1000 cell entries.
 *
 * @param {Object} ast - The AST
 * @returns {Array<{row: number, col: number} | {startRow: number, endRow: number, startCol: number, endCol: number}>}
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
                refs.push({
                    startRow: Math.min(node.start.row, node.end.row),
                    endRow:   Math.max(node.start.row, node.end.row),
                    startCol: Math.min(node.start.col, node.end.col),
                    endCol:   Math.max(node.start.col, node.end.col),
                });
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
                // Cross-sheet refs are tracked separately; don't add them to the
                // same-sheet dependency graph (which uses row/col keys only).
                break;
        }
    }

    visit(ast);
    return refs;
}

/**
 * Walk an AST and collect the table-name dependencies of any TABLE_* function calls.
 * Returns { tableNames, wildcard }:
 *   tableNames - Set of uppercase table names referenced via string-literal first arg
 *   wildcard   - true when at least one TABLE_* call has a non-literal first arg
 *                (e.g. `TABLE_GET(A1, ...)`) — caller must treat as "depends on any table"
 *
 * @param {Object} ast
 * @returns {{ tableNames: Set<string>, wildcard: boolean }}
 */
export function extractTableDeps(ast) {
    const tableNames = new Set();
    let wildcard = false;

    function visit(node) {
        if (!node) return;
        switch (node.type) {
            case NodeType.FUNCTION_CALL: {
                if (typeof node.name === 'string' && node.name.startsWith('TABLE_')) {
                    const first = node.args?.[0];
                    if (first?.type === NodeType.STRING) {
                        tableNames.add(String(first.value).toUpperCase());
                    } else {
                        wildcard = true;
                    }
                }
                node.args?.forEach(visit);
                break;
            }
            case NodeType.BINARY_OP:
                visit(node.left);
                visit(node.right);
                break;
            case NodeType.UNARY_OP:
                visit(node.operand);
                break;
        }
    }

    visit(ast);
    return { tableNames, wildcard };
}

export default parseFormula;
