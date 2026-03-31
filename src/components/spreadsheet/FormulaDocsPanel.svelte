<script>
    /**
     * FormulaDocsPanel — Full formula reference, opened from Help menu.
     *
     * Renders as a fixed full-screen overlay with:
     *   - Search bar
     *   - Category sidebar
     *   - Scrollable function list with syntax, description, and examples
     */

    let { onclose } = $props();

    // ── Formula data ─────────────────────────────────────────────────────────

    const CATEGORIES = [
        { id: "all", label: "All Functions" },
        { id: "math", label: "Math & Stats" },
        { id: "logic", label: "Logic" },
        { id: "text", label: "Text" },
        { id: "lookup", label: "Lookup" },
        { id: "info", label: "Information" },
        { id: "aggregate", label: "Conditional Aggregate" },
        { id: "array", label: "Array & Spill" },
        { id: "table", label: "Table (in-column)" },
        { id: "tableext", label: "Table (cross-sheet)" },
    ];

    /** @type {Array<{cat: string, name: string, syntax: string, desc: string, example: string, note?: string}>} */
    const FORMULAS = [
        // ── Math & Stats ────────────────────────────────────────────────────
        {
            cat: "math",
            name: "SUM",
            syntax: "SUM(value1, [value2, …])",
            desc: "Returns the sum of all numeric values. Accepts individual values, cell references, and ranges.",
            example:
                "=SUM(A1:A10)  →  sum of rows 1–10\n=SUM(A1, B1, C1)  →  sum of three cells",
        },
        {
            cat: "math",
            name: "AVERAGE",
            syntax: "AVERAGE(value1, [value2, …])",
            desc: "Returns the arithmetic mean of all numeric values. Non-numeric values are ignored.",
            example: "=AVERAGE(B1:B5)  →  average of five values",
        },
        {
            cat: "math",
            name: "COUNT",
            syntax: "COUNT(value1, [value2, …])",
            desc: "Counts cells that contain numbers. Text and empty cells are not counted.",
            example: "=COUNT(A1:A20)  →  how many cells contain numbers",
        },
        {
            cat: "math",
            name: "COUNTA",
            syntax: "COUNTA(value1, [value2, …])",
            desc: "Counts all non-empty cells regardless of type (numbers, text, dates, etc.).",
            example: "=COUNTA(A1:A20)  →  how many cells are non-empty",
        },
        {
            cat: "math",
            name: "MIN",
            syntax: "MIN(value1, [value2, …])",
            desc: "Returns the smallest value in a set of numbers.",
            example: "=MIN(A1:A10)  →  lowest number in range",
        },
        {
            cat: "math",
            name: "MAX",
            syntax: "MAX(value1, [value2, …])",
            desc: "Returns the largest value in a set of numbers.",
            example: "=MAX(A1:A10)  →  highest number in range",
        },
        {
            cat: "math",
            name: "ABS",
            syntax: "ABS(number)",
            desc: "Returns the absolute (non-negative) value of a number.",
            example:
                "=ABS(-5)  →  5\n=ABS(A1 - B1)  →  magnitude of difference",
        },
        {
            cat: "math",
            name: "ROUND",
            syntax: "ROUND(number, decimals)",
            desc: "Rounds a number to the specified number of decimal places. Use 0 for whole numbers, negative values to round left of the decimal.",
            example: "=ROUND(3.14159, 2)  →  3.14\n=ROUND(1234, -2)  →  1200",
        },
        {
            cat: "math",
            name: "FLOOR",
            syntax: "FLOOR(number)",
            desc: "Rounds a number down to the nearest integer (toward negative infinity).",
            example: "=FLOOR(3.9)  →  3\n=FLOOR(-1.2)  →  -2",
        },
        {
            cat: "math",
            name: "CEILING",
            syntax: "CEILING(number)",
            desc: "Rounds a number up to the nearest integer (toward positive infinity).",
            example: "=CEILING(3.1)  →  4\n=CEILING(-1.8)  →  -1",
        },
        {
            cat: "math",
            name: "SQRT",
            syntax: "SQRT(number)",
            desc: "Returns the positive square root of a number.",
            example: "=SQRT(16)  →  4\n=SQRT(A1)",
        },
        {
            cat: "math",
            name: "POWER",
            syntax: "POWER(base, exponent)",
            desc: "Raises a number to a given power. Equivalent to the ^ operator.",
            example:
                "=POWER(2, 10)  →  1024\n=POWER(A1, 0.5)  →  square root of A1",
        },
        {
            cat: "math",
            name: "MOD",
            syntax: "MOD(number, divisor)",
            desc: "Returns the remainder after dividing number by divisor.",
            example:
                "=MOD(10, 3)  →  1\n=MOD(ROW(), 2)  →  0 for even rows, 1 for odd",
        },

        // ── Logic ─────────────────────────────────────────────────────────
        {
            cat: "logic",
            name: "IF",
            syntax: "IF(condition, value_if_true, value_if_false)",
            desc: "Returns one value if a condition is true and another value if it is false. Conditions use comparison operators: =, <>, >, <, >=, <=.",
            example:
                '=IF(A1 > 0, "Positive", "Non-positive")\n=IF(B1 = "done", 1, 0)',
        },
        {
            cat: "logic",
            name: "AND",
            syntax: "AND(condition1, [condition2, …])",
            desc: "Returns TRUE if all conditions are true, FALSE if any condition is false.",
            example:
                '=AND(A1 > 0, B1 < 100)  →  TRUE only if both hold\n=IF(AND(A1="yes", B1>5), "pass", "fail")',
        },
        {
            cat: "logic",
            name: "OR",
            syntax: "OR(condition1, [condition2, …])",
            desc: "Returns TRUE if at least one condition is true.",
            example: '=OR(A1 = "yes", A1 = "maybe")  →  TRUE if either matches',
        },
        {
            cat: "logic",
            name: "NOT",
            syntax: "NOT(condition)",
            desc: "Reverses the logical value: NOT(TRUE) returns FALSE, and vice versa.",
            example: "=NOT(ISBLANK(A1))  →  TRUE if A1 is not blank",
        },
        {
            cat: "logic",
            name: "IFERROR",
            syntax: "IFERROR(value, value_if_error)",
            desc: "Returns value_if_error if the first argument evaluates to an error, otherwise returns the value itself. Useful for suppressing #DIV/0!, #REF!, #N/A, etc.",
            example:
                '=IFERROR(A1/B1, 0)  →  0 if B1 is zero\n=IFERROR(VLOOKUP(A1, B:C, 2, FALSE), "Not found")',
        },

        // ── Text ──────────────────────────────────────────────────────────
        {
            cat: "text",
            name: "LEN",
            syntax: "LEN(text)",
            desc: "Returns the number of characters in a text string.",
            example: '=LEN("hello")  →  5\n=LEN(A1)',
        },
        {
            cat: "text",
            name: "UPPER",
            syntax: "UPPER(text)",
            desc: "Converts all characters in a text string to uppercase.",
            example: '=UPPER("hello")  →  "HELLO"',
        },
        {
            cat: "text",
            name: "LOWER",
            syntax: "LOWER(text)",
            desc: "Converts all characters in a text string to lowercase.",
            example: '=LOWER("HELLO")  →  "hello"',
        },
        {
            cat: "text",
            name: "TRIM",
            syntax: "TRIM(text)",
            desc: "Removes leading and trailing spaces, and reduces internal multiple spaces to a single space.",
            example: '=TRIM("  hello  ")  →  "hello"',
        },
        {
            cat: "text",
            name: "LEFT",
            syntax: "LEFT(text, num_chars)",
            desc: "Returns the specified number of characters from the start (left side) of a text string.",
            example: '=LEFT("Formula", 3)  →  "For"',
        },
        {
            cat: "text",
            name: "RIGHT",
            syntax: "RIGHT(text, num_chars)",
            desc: "Returns the specified number of characters from the end (right side) of a text string.",
            example: '=RIGHT("Formula", 4)  →  "mula"',
        },
        {
            cat: "text",
            name: "MID",
            syntax: "MID(text, start, num_chars)",
            desc: "Returns a substring from inside a text string. start is 1-based (1 = first character).",
            example: '=MID("Formula", 2, 3)  →  "orm"',
        },
        {
            cat: "text",
            name: "CONCATENATE",
            syntax: "CONCATENATE(text1, [text2, …])",
            desc: "Joins multiple text strings into one. You can also use the & operator.",
            example:
                '=CONCATENATE("Hello", " ", "World")  →  "Hello World"\n=A1 & " " & B1',
        },

        // ── Lookup ─────────────────────────────────────────────────────────
        {
            cat: "lookup",
            name: "VLOOKUP",
            syntax: "VLOOKUP(search_key, range, col_index, [exact_match])",
            desc: "Searches for a value in the first column of a range and returns a value from a specified column in the same row. Set exact_match to FALSE for approximate match (useful for sorted data).",
            example:
                '=VLOOKUP(A1, B1:D10, 2, TRUE)  →  finds A1 in col B, returns col C\n=VLOOKUP("John", A:C, 3, TRUE)  →  finds "John", returns 3rd column',
        },
        {
            cat: "lookup",
            name: "IMPORTRANGE",
            syntax: "IMPORTRANGE(fileId, rangeString)",
            desc: 'Import data from another spreadsheet. fileId can be a file ID or URL. rangeString specifies the sheet and cells to import (e.g., "Sheet1!A1:C10"). Returns a spill range with the imported data.',
            example:
                '=IMPORTRANGE("1a2b3c4d5e", "Sheet1!A1:C10")  →  import data from another file\n=IMPORTRANGE(A1, "Data!A:A")  →  import column A from another sheet',
        },

        // ── Information ─────────────────────────────────────────────────────
        {
            cat: "info",
            name: "ISBLANK",
            syntax: "ISBLANK(value)",
            desc: "Returns TRUE if the referenced cell is empty, FALSE otherwise.",
            example: "=ISBLANK(A1)  →  TRUE if A1 is empty",
        },
        {
            cat: "info",
            name: "ISNUMBER",
            syntax: "ISNUMBER(value)",
            desc: "Returns TRUE if the value is a number.",
            example: "=ISNUMBER(A1)  →  TRUE if A1 contains a number",
        },
        {
            cat: "info",
            name: "ISTEXT",
            syntax: "ISTEXT(value)",
            desc: "Returns TRUE if the value is text.",
            example: "=ISTEXT(A1)  →  TRUE if A1 contains text",
        },
        {
            cat: "info",
            name: "ISERROR",
            syntax: "ISERROR(value)",
            desc: "Returns TRUE if the value is any error (#ERROR!, #REF!, #DIV/0!, etc.).",
            example: "=ISERROR(A1/B1)  →  TRUE if division fails",
        },
        {
            cat: "info",
            name: "NA",
            syntax: "NA()",
            desc: "Returns the #N/A error value. Used to mark cells that should not be matched or calculated.",
            example: "=NA()  →  #N/A",
        },

        // ── Conditional Aggregate ───────────────────────────────────────────
        {
            cat: "aggregate",
            name: "SUMIF",
            syntax: "SUMIF(range, criteria, [sum_range])",
            desc: "Sum of cells that match a condition. If sum_range is omitted, the range being summed is the same as the range being tested.",
            example:
                '=SUMIF(A1:A10, ">100")  →  sum of values > 100\n=SUMIF(Status, "done", Amount)  →  sum amounts for done items\n=SUMIF(Category, "Food", Price)  →  sum food prices',
        },
        {
            cat: "aggregate",
            name: "COUNTIF",
            syntax: "COUNTIF(range, criteria)",
            desc: "Count of cells that match a condition. Supports exact matches, comparisons (>5, >=5, <5, <=5, <>5), and wildcards (* and ?).",
            example:
                '=COUNTIF(A1:A10, "Yes")  →  count "Yes" values\n=COUNTIF(Score, ">=90")  →  count high scores\n=COUNTIF(Name, "J*")  →  count names starting with J',
        },
        {
            cat: "aggregate",
            name: "AVERAGEIF",
            syntax: "AVERAGEIF(range, criteria, [average_range])",
            desc: "Average of cells that match a condition. If average_range is omitted, the range being averaged is the same as the range being tested.",
            example:
                '=AVERAGEIF(A1:A10, ">100")  →  average of values > 100\n=AVERAGEIF(Grade, "A", Score)  →  average score for A-grade\n=AVERAGEIF(Region, "West", Revenue)  →  average west revenue',
        },

        // ── Array & Spill ──────────────────────────────────────────────────
        {
            cat: "array",
            name: "FILTER",
            syntax: "FILTER(range, condition1, [condition2, …])",
            desc: "Filter a range by one or more conditions (AND logic). Returns matching rows in a spill range. Each condition should evaluate to TRUE/FALSE for each row. Non-numeric values are treated as TRUE if non-zero/non-empty.",
            example:
                '=FILTER(A1:C10, B1:B10 > 100)  →  rows where B > 100\n=FILTER(Data, Status = "Active", Amount > 50)  →  multiple conditions\n=FILTER(A:C, (B:B="Sales") * (C:C>1000))  →  complex filter',
        },
        {
            cat: "array",
            name: "SORT",
            syntax: "SORT(range, [sort_index], [sort_order], [sort_index2], [sort_order2], …])",
            desc: "Sort a range by one or more columns. sort_index is 1-based column number. sort_order: TRUE (ascending, default) or FALSE (descending). Returns spilled result.",
            example:
                "=SORT(A1:C10)  →  sort by first column ascending\n=SORT(A1:C10, 2, FALSE)  →  sort by 2nd column descending\n=SORT(A1:C10, 1, TRUE, 2, FALSE)  →  primary sort col 1 asc, secondary col 2 desc",
        },
        {
            cat: "array",
            name: "UNIQUE",
            syntax: "UNIQUE(range)",
            desc: "Return unique rows from a range, removing duplicates. Preserves first occurrence order.",
            example:
                "=UNIQUE(A1:A100)  →  unique values\n=UNIQUE(A1:C10)  →  unique rows from 2D range\n=UNIQUE(Names)  →  deduplicated list",
        },
        {
            cat: "array",
            name: "TRANSPOSE",
            syntax: "TRANSPOSE(range)",
            desc: "Swap rows and columns. A 3×5 range becomes 5×3.",
            example:
                "=TRANSPOSE(A1:C5)  →  flip rows/columns\n=TRANSPOSE(Data)  →  transpose entire range",
        },
        {
            cat: "array",
            name: "TOCOL",
            syntax: "TOCOL(range)",
            desc: "Flatten a range into a single column. 2D arrays and 1D arrays both become a vertical list.",
            example:
                "=TOCOL(A1:C5)  →  all values in single column\n=TOCOL(Matrix)  →  flatten to column",
        },
        {
            cat: "array",
            name: "TOROW",
            syntax: "TOROW(range)",
            desc: "Flatten a range into a single row. 2D arrays and 1D arrays both become a horizontal list.",
            example:
                "=TOROW(A1:C5)  →  all values in single row\n=TOROW(Matrix)  →  flatten to row",
        },
        {
            cat: "array",
            name: "HSTACK",
            syntax: "HSTACK(range1, range2, […])",
            desc: "Stack arrays horizontally (side by side). Combines multiple ranges left-to-right.",
            example:
                "=HSTACK(A1:B10, D1:E10)  →  place side by side\n=HSTACK(List1, List2, List3)  →  combine 3 lists",
        },
        {
            cat: "array",
            name: "VSTACK",
            syntax: "VSTACK(range1, range2, […])",
            desc: "Stack arrays vertically (one below another). Combines multiple ranges top-to-bottom.",
            example:
                "=VSTACK(A1:C5, A7:C10)  →  stack vertically\n=VSTACK(Jan, Feb, Mar)  →  combine months",
        },
        {
            cat: "array",
            name: "TAKE",
            syntax: "TAKE(range, rows, [cols])",
            desc: "Take N rows/columns from a range. Positive rows = from top, negative = from bottom. Same logic for cols.",
            example:
                "=TAKE(A1:C10, 5)  →  first 5 rows\n=TAKE(A1:C10, -3)  →  last 3 rows\n=TAKE(A1:C10, 5, 2)  →  first 5 rows, first 2 cols",
        },
        {
            cat: "array",
            name: "DROP",
            syntax: "DROP(range, rows, [cols])",
            desc: "Drop (skip) N rows/columns. Positive rows = drop from top, negative = from bottom.",
            example:
                "=DROP(A1:C10, 1)  →  all rows except first (skip headers)\n=DROP(A1:C10, -2)  →  drop last 2 rows\n=DROP(A1:C10, 1, 1)  →  skip first row and column",
        },
        {
            cat: "array",
            name: "CHOOSEROWS",
            syntax: "CHOOSEROWS(range, row_num1, [row_num2, …])",
            desc: "Select specific rows by index (1-based). Negative indices count from end (-1 = last row).",
            example:
                "=CHOOSEROWS(A1:C10, 1, 3, 5)  →  rows 1, 3, 5\n=CHOOSEROWS(Data, 1, -1)  →  first and last row\n=CHOOSEROWS(List, 2)  →  second row only",
        },
        {
            cat: "array",
            name: "CHOOSECOLS",
            syntax: "CHOOSECOLS(range, col_num1, [col_num2, …])",
            desc: "Select specific columns by index (1-based). Negative indices count from end (-1 = last column).",
            example:
                "=CHOOSECOLS(A1:C10, 1, 3)  →  columns A and C\n=CHOOSECOLS(Data, 2)  →  column B only\n=CHOOSECOLS(Data, -1)  →  last column",
        },
        {
            cat: "array",
            name: "WRAPCOLS",
            syntax: "WRAPCOLS(range, wrap_count, [pad_value])",
            desc: "Wrap a flat (1D) range into columns of a given size. Useful for reshaping data.",
            example:
                '=WRAPCOLS(A1:A20, 3)  →  wrap 20 items into 3-item columns\n=WRAPCOLS(Numbers, 5, "N/A")  →  wrap with padding',
        },
        {
            cat: "array",
            name: "WRAPROWS",
            syntax: "WRAPROWS(range, wrap_count, [pad_value])",
            desc: "Wrap a flat (1D) range into rows of a given size. Useful for reshaping data.",
            example:
                "=WRAPROWS(A1:A20, 5)  →  wrap 20 items into 5-item rows\n=WRAPROWS(Data, 3)  →  reshape to 3-item rows",
        },
        {
            cat: "array",
            name: "EXPAND",
            syntax: "EXPAND(range, rows, cols, [pad_value])",
            desc: "Expand a range to specified dimensions (rows × cols), padding with a value (default empty).",
            example:
                '=EXPAND(A1:B2, 5, 5)  →  expand to 5×5\n=EXPAND(Data, 10, 10, 0)  →  pad with zeros\n=EXPAND(Cell, 3, 3, "")  →  expand to 3×3 grid',
        },

        // ── Table Formulas ─────────────────────────────────────────────────
        {
            cat: "table",
            name: "{colName}",
            syntax: "{colName}",
            desc: "Substitutes the current row's value for the named column. Use the column's display name (case-insensitive) or its internal ID. This is how you reference data within the same table row in a computed column. You can also use TABLE_* cross-sheet functions inside computed column formulas — combine them with {colRef} to look up values from other tables.",
            example:
                '{price} * {qty}  →  row total\nIF({status} = "done", 1, 0)  →  completion flag\nTABLE_LOOKUP("Rates", "code", {rateCode}, "rate") * {hours}  →  cross-table lookup',
        },
        {
            cat: "table",
            name: "ROW",
            syntax: "ROW",
            desc: "The current row's 0-based index in the table (0 = first row).",
            example: "ROW + 1  →  same as ROW1",
        },
        {
            cat: "table",
            name: "ROW1",
            syntax: "ROW1",
            desc: "The current row's 1-based index in the table (1 = first row). Useful for sequential numbering.",
            example: "ROW1  →  1, 2, 3, …",
        },
        {
            cat: "table",
            name: "COUNT",
            syntax: "COUNT",
            desc: "The total number of rows in the (filtered) table. Can be used in arithmetic.",
            example:
                'ROW1 / COUNT  →  row as fraction of total\nIF(ROW1 = COUNT, "Last", "")  →  flag last row',
            note: "Used as a token (no parentheses), not a function call.",
        },
        {
            cat: "table",
            name: "CUMSUM",
            syntax: "CUMSUM(colName)",
            desc: "Running total of colName from the first row up to and including the current row. Cached for performance.",
            example:
                "CUMSUM(amount)  →  running balance\nCUMSUM(qty)  →  cumulative quantity",
        },
        {
            cat: "table",
            name: "RUNNINGIF",
            syntax: 'RUNNINGIF(sumCol, filterCol, "op", filterVal)',
            desc: 'Running conditional sum: sums sumCol where filterCol matches the condition, from row 0 up to the current row. The op string can be "=", "<>", ">", "<", ">=", "<=", "contains", "startswith", "notcontains".',
            example:
                'RUNNINGIF(amount, account, "=", {account})  →  per-account running balance\nRUNNINGIF(debit, type, "=", "expense")  →  running expense total',
        },
        {
            cat: "table",
            name: "RUNNINGIFS",
            syntax: 'RUNNINGIFS(sumCol, col1, "op1", val1, col2, "op2", val2, …)',
            desc: "Running conditional sum with multiple conditions (all must match). Conditions are specified as col, op, value triples.",
            example:
                'RUNNINGIFS(amount, account, "=", {account}, type, "=", "credit")',
        },
        {
            cat: "table",
            name: "SUM (table)",
            syntax: "SUM(colName)",
            desc: "Total sum of colName across all (filtered) rows. Re-evaluated for every row since it reflects the whole table.",
            example:
                "SUM(amount)  →  grand total\n{amount} / SUM(amount)  →  row's share of total",
        },
        {
            cat: "table",
            name: "AVG",
            syntax: "AVG(colName)",
            desc: "Average of colName across all (filtered) rows.",
            example:
                "AVG(score)  →  table-wide average\n{score} - AVG(score)  →  deviation from mean",
        },
        {
            cat: "table",
            name: "MIN (table)",
            syntax: "MIN(colName)",
            desc: "Minimum value of colName across all (filtered) rows.",
            example: "MIN(price)  →  lowest price in table",
        },
        {
            cat: "table",
            name: "MAX (table)",
            syntax: "MAX(colName)",
            desc: "Maximum value of colName across all (filtered) rows.",
            example:
                "MAX(score)  →  highest score\n{score} / MAX(score)  →  relative score",
        },
        {
            cat: "table",
            name: "SUMIF",
            syntax: 'SUMIF(sumCol, filterCol, "op", filterVal)',
            desc: "Sum of sumCol for all rows where filterCol satisfies the condition. Unlike RUNNINGIF, this always totals the entire table (not just up to the current row).",
            example:
                'SUMIF(amount, category, "=", "Food")  →  total food spending\nSUMIF(cost, region, "=", {region})  →  regional total for this row\'s region',
        },
        {
            cat: "table",
            name: "SUMIFS",
            syntax: 'SUMIFS(sumCol, col1, "op1", val1, col2, "op2", val2, …)',
            desc: "Sum of sumCol where all conditions are met. Conditions are col, op, val triples.",
            example: 'SUMIFS(cost, vendor, "=", "Amazon", year, "=", "2024")',
        },
        {
            cat: "table",
            name: "COUNTIF",
            syntax: 'COUNTIF(filterCol, "op", filterVal)',
            desc: "Count of rows where filterCol satisfies the condition.",
            example:
                'COUNTIF(status, "=", "done")  →  completed items\nCOUNTIF(score, ">=", 90)  →  A-grade rows',
        },
        {
            cat: "table",
            name: "AVGIF",
            syntax: 'AVGIF(sumCol, filterCol, "op", filterVal)',
            desc: "Average of sumCol for rows where filterCol satisfies the condition.",
            example: 'AVGIF(score, grade, "=", "A")  →  average A-grade score',
        },
        {
            cat: "table",
            name: "MINIF",
            syntax: 'MINIF(col, filterCol, "op", filterVal)',
            desc: "Minimum value of col for rows where filterCol satisfies the condition.",
            example: 'MINIF(price, category, "=", "Books")  →  cheapest book',
        },
        {
            cat: "table",
            name: "MAXIF",
            syntax: 'MAXIF(col, filterCol, "op", filterVal)',
            desc: "Maximum value of col for rows where filterCol satisfies the condition.",
            example:
                'MAXIF(score, team, "=", {team})  →  best score on this row\'s team',
        },

        // ── Cross-sheet TABLE_* formulas ──────────────────────────────────────
        // Used in regular grid cells to query any named table from anywhere in the sheet.
        // TABLE_* functions also work inside computed column formulas — combine them with
        // {colRef} references to look up values across tables.

        {
            cat: "tableext",
            name: "TABLE_GET",
            syntax: "TABLE_GET(tableName, rowIndex, colId)",
            desc: "Returns the value at a specific row and column of a named table. rowIndex is 0-based. colId can be the column name or internal ID.",
            example:
                '=TABLE_GET("Sales", 0, "amount")  →  first row\'s amount\n=TABLE_GET("Products", A1-1, "price")  →  price for row from A1',
        },
        {
            cat: "tableext",
            name: "TABLE_COL",
            syntax: "TABLE_COL(tableName, colId)",
            desc: "Returns all values from a table column as an array. The array can be passed directly to SUM, AVERAGE, COUNT, MAX, MIN, and other functions that accept ranges.",
            example:
                '=SUM(TABLE_COL("Sales", "amount"))  →  total of all amounts\n=AVERAGE(TABLE_COL("Scores", "value"))  →  mean score',
            note: "Returns the full column regardless of any filters applied in the table UI. Use TABLE_FILTERCOL to apply conditions.",
        },
        {
            cat: "tableext",
            name: "TABLE_FILTERCOL",
            syntax: 'TABLE_FILTERCOL(tableName, colId, filterColId, "op", filterValue)',
            desc: "Returns values from colId as an array, keeping only rows where filterColId satisfies the condition. The result is an array you can pass to SUM, AVERAGE, COUNT, MAX, MIN, etc. This is the primary way to query a table and process a filtered set of values.",
            example:
                '=SUM(TABLE_FILTERCOL("Sales", "amount", "region", "=", "West"))  →  West region total\n=COUNT(TABLE_FILTERCOL("Tasks", "id", "status", "=", "done"))  →  completed count\n=AVERAGE(TABLE_FILTERCOL("Scores", "value", "grade", "<>", "F"))  →  passing average',
        },
        {
            cat: "tableext",
            name: "TABLE_FILTERCOLIFS",
            syntax: 'TABLE_FILTERCOLIFS(tableName, colId, col1, "op1", val1, col2, "op2", val2, …)',
            desc: "Like TABLE_FILTERCOL but with multiple filter conditions — all conditions must match. Conditions are specified as col, op, value triples.",
            example:
                '=SUM(TABLE_FILTERCOLIFS("Sales","amount","region","=","West","year","=",2024))\n=MAX(TABLE_FILTERCOLIFS("Orders","total","status","=","paid","tier","=","premium"))',
        },
        {
            cat: "tableext",
            name: "TABLE_LOOKUP",
            syntax: "TABLE_LOOKUP(tableName, lookupColId, lookupValue, returnColId)",
            desc: "Finds the first row where lookupColId equals lookupValue and returns that row's value in returnColId. Returns #N/A if no match. This is the clearest way to look up a value by key, like VLOOKUP but using column names instead of column numbers.",
            example:
                '=TABLE_LOOKUP("Products", "sku", A1, "price")  →  price for the SKU in A1\n=TABLE_LOOKUP("Users", "id", B2, "email")  →  email for user ID in B2\n=IFERROR(TABLE_LOOKUP("Rates", "code", C1, "rate"), 0)  →  0 if not found',
        },
        {
            cat: "tableext",
            name: "TABLE_FILTER",
            syntax: "TABLE_FILTER(tableName, colId, op, value)",
            desc: "Count of rows in a named table where the column matches the condition. Legacy function; use TABLE_COUNTIF instead for consistency.",
            example:
                '=TABLE_FILTER("Tasks", "status", "=", "done")  →  count of done items',
        },
        {
            cat: "tableext",
            name: "TABLE_COUNT",
            syntax: "TABLE_COUNT(tableName)",
            desc: "Returns the total number of rows in the named table.",
            example:
                '=TABLE_COUNT("Sales")  →  number of sales records\n=TABLE_COUNT("Tasks") & " tasks"  →  "42 tasks"',
        },
        {
            cat: "tableext",
            name: "TABLE_SUM",
            syntax: "TABLE_SUM(tableName, colId)",
            desc: "Sum of all values in a column. Equivalent to =SUM(TABLE_COL(…)) but shorter.",
            example: '=TABLE_SUM("Sales", "revenue")  →  total revenue',
        },
        {
            cat: "tableext",
            name: "TABLE_AVG",
            syntax: "TABLE_AVG(tableName, colId)",
            desc: "Average of all values in a column.",
            example: '=TABLE_AVG("Scores", "value")  →  overall average',
        },
        {
            cat: "tableext",
            name: "TABLE_MIN",
            syntax: "TABLE_MIN(tableName, colId)",
            desc: "Minimum value in a column.",
            example: '=TABLE_MIN("Prices", "cost")  →  cheapest item',
        },
        {
            cat: "tableext",
            name: "TABLE_MAX",
            syntax: "TABLE_MAX(tableName, colId)",
            desc: "Maximum value in a column.",
            example: '=TABLE_MAX("Scores", "value")  →  top score',
        },
        {
            cat: "tableext",
            name: "TABLE_SUMIF",
            syntax: 'TABLE_SUMIF(tableName, sumColId, filterColId, "op", filterValue)',
            desc: "Sum of sumColId for rows where filterColId satisfies the condition.",
            example:
                '=TABLE_SUMIF("Sales", "amount", "region", "=", "West")  →  West total\n=TABLE_SUMIF("Expenses", "cost", "approved", "=", "yes")',
        },
        {
            cat: "tableext",
            name: "TABLE_SUMIFS",
            syntax: 'TABLE_SUMIFS(tableName, sumColId, col1, "op1", val1, col2, "op2", val2, …)',
            desc: "Sum of sumColId where all conditions are met. Conditions are col, op, val triples.",
            example:
                '=TABLE_SUMIFS("Sales","amount","region","=","West","year","=",2024)',
        },
        {
            cat: "tableext",
            name: "TABLE_COUNTIF",
            syntax: 'TABLE_COUNTIF(tableName, filterColId, "op", filterValue)',
            desc: "Count of rows where filterColId satisfies the condition.",
            example:
                '=TABLE_COUNTIF("Tasks", "status", "=", "done")  →  completed count\n=TABLE_COUNTIF("Sales", "amount", ">", 1000)  →  large orders',
        },
        {
            cat: "tableext",
            name: "TABLE_COUNTIFS",
            syntax: 'TABLE_COUNTIFS(tableName, col1, "op1", val1, col2, "op2", val2, …)',
            desc: "Count of rows where all conditions are met.",
            example:
                '=TABLE_COUNTIFS("Sales","region","=","West","year","=",2024)',
        },
        {
            cat: "tableext",
            name: "TABLE_AVGIF",
            syntax: 'TABLE_AVGIF(tableName, sumColId, filterColId, "op", filterValue)',
            desc: "Average of sumColId for rows where filterColId satisfies the condition.",
            example:
                '=TABLE_AVGIF("Scores", "value", "grade", "=", "A")  →  average A score',
        },
        {
            cat: "tableext",
            name: "TABLE_AVGIFS",
            syntax: 'TABLE_AVGIFS(tableName, sumColId, col1, "op1", val1, col2, "op2", val2, …)',
            desc: "Average of sumColId where all conditions are met.",
            example:
                '=TABLE_AVGIFS("Scores","value","grade","=","A","semester","=","Fall")',
        },
        {
            cat: "tableext",
            name: "TABLE_MINIF",
            syntax: 'TABLE_MINIF(tableName, colId, filterColId, "op", filterValue)',
            desc: "Minimum of colId for rows matching the condition.",
            example:
                '=TABLE_MINIF("Prices", "cost", "category", "=", "Books")  →  cheapest book',
        },
        {
            cat: "tableext",
            name: "TABLE_MAXIF",
            syntax: 'TABLE_MAXIF(tableName, colId, filterColId, "op", filterValue)',
            desc: "Maximum of colId for rows matching the condition.",
            example:
                '=TABLE_MAXIF("Scores", "value", "region", "=", "West")  →  West top score',
        },
        {
            cat: "tableext",
            name: "TABLE_CUMSUM",
            syntax: "TABLE_CUMSUM(tableName, colId, upToIndex)",
            desc: "Cumulative sum of colId from the first row up to upToIndex (0-based, inclusive). Useful for building running-total summaries outside the table.",
            example:
                '=TABLE_CUMSUM("Sales", "amount", 4)  →  running total through row 5',
        },
    ];

    // ── Filter state ─────────────────────────────────────────────────────────

    let query = $state("");
    let activeCategory = $state("all");

    let filtered = $derived.by(() => {
        const q = query.trim().toLowerCase();
        return FORMULAS.filter((f) => {
            // Category filter
            if (activeCategory !== "all" && f.cat !== activeCategory)
                return false;
            // Search filter
            if (!q) return true;
            return (
                f.name.toLowerCase().includes(q) ||
                f.desc.toLowerCase().includes(q) ||
                f.syntax.toLowerCase().includes(q)
            );
        });
    });

    let counts = $derived.by(() => {
        const q = query.trim().toLowerCase();
        const map = { all: 0 };
        for (const cat of CATEGORIES.filter((c) => c.id !== "all")) {
            map[cat.id] = 0;
        }
        for (const f of FORMULAS) {
            if (
                !q ||
                f.name.toLowerCase().includes(q) ||
                f.desc.toLowerCase().includes(q)
            ) {
                map[f.cat] = (map[f.cat] ?? 0) + 1;
                map.all++;
            }
        }
        return map;
    });

    // ── Interaction ───────────────────────────────────────────────────────────

    function handleKeydown(e) {
        if (e.key === "Escape") {
            e.preventDefault();
            onclose?.();
        }
    }

    function handleBackdrop(e) {
        if (e.target === e.currentTarget) onclose?.();
    }

    /** Group filtered results by category for section headers */
    let grouped = $derived.by(() => {
        if (activeCategory !== "all")
            return [{ cat: activeCategory, items: filtered }];
        const map = new Map();
        for (const f of filtered) {
            if (!map.has(f.cat)) map.set(f.cat, []);
            map.get(f.cat).push(f);
        }
        const order = [
            "math",
            "logic",
            "text",
            "lookup",
            "info",
            "aggregate",
            "array",
            "table",
            "tableext",
        ];
        return order
            .filter((c) => map.has(c))
            .map((c) => ({
                cat: c,
                label: CATEGORIES.find((cat) => cat.id === c)?.label ?? c,
                items: map.get(c),
            }));
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="backdrop"
    onclick={handleBackdrop}
    onkeydown={handleKeydown}
    role="presentation"
>
    <div
        class="panel"
        role="dialog"
        aria-label="Formula Reference"
        aria-modal="true"
    >
        <!-- Header -->
        <div class="panel-header">
            <div class="header-left">
                <span class="header-fx">fx</span>
                <h2 class="header-title">Formula Reference</h2>
            </div>
            <div class="header-search">
                <svg
                    class="search-icon"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                >
                    <circle cx="6.5" cy="6.5" r="4" />
                    <path d="M9.5 9.5l3 3" />
                </svg>
                <input
                    class="search-input"
                    type="search"
                    placeholder="Search functions…"
                    bind:value={query}
                    autocomplete="off"
                    spellcheck="false"
                />
            </div>
            <button
                class="close-btn"
                onclick={() => onclose?.()}
                aria-label="Close"
            >
                <svg
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                >
                    <path d="M2 2l8 8M10 2l-8 8" />
                </svg>
            </button>
        </div>

        <!-- Body -->
        <div class="panel-body">
            <!-- Sidebar -->
            <nav class="sidebar" aria-label="Categories">
                {#each CATEGORIES as cat}
                    {@const count = counts[cat.id] ?? 0}
                    <button
                        class="cat-btn"
                        class:active={activeCategory === cat.id}
                        onclick={() => (activeCategory = cat.id)}
                        disabled={count === 0 && query !== ""}
                    >
                        <span class="cat-label">{cat.label}</span>
                        <span class="cat-count">{count}</span>
                    </button>
                {/each}

                <div class="sidebar-divider"></div>

                <div class="sidebar-note">
                    <strong>Table (in-column)</strong> formulas go in a column's
                    formula field and use <code>{"{colName}"}</code> for row
                    values.<br /><br />
                    <strong>Table (cross-sheet)</strong> <code>TABLE_*</code> functions
                    go in any grid cell to query a named table. They also work inside
                    computed column formulas.
                </div>
            </nav>

            <!-- Content -->
            <div class="content" role="list">
                {#if filtered.length === 0}
                    <div class="empty-state">
                        <span class="empty-icon">🔍</span>
                        <p>No functions match "<strong>{query}</strong>"</p>
                    </div>
                {:else}
                    {#each grouped as group}
                        {#if activeCategory === "all"}
                            <div class="group-header">
                                {group.label}
                                <span class="group-count"
                                    >{group.items.length}</span
                                >
                            </div>
                        {/if}
                        {#each group.items as fn (fn.name)}
                            <div class="fn-card" role="listitem">
                                <div class="fn-top">
                                    <span class="fn-name">{fn.name}</span>
                                    <code class="fn-syntax">{fn.syntax}</code>
                                </div>
                                <p class="fn-desc">{fn.desc}</p>
                                {#if fn.note}
                                    <p class="fn-note">{fn.note}</p>
                                {/if}
                                <pre class="fn-example">{fn.example}</pre>
                            </div>
                        {/each}
                    {/each}
                {/if}
            </div>
        </div>

        <!-- Footer -->
        <div class="panel-footer">
            <span class="footer-note">
                Start any cell formula with <code>=</code> · Table
                computed-column formulas do not use <code>=</code>
            </span>
            <button class="footer-close-btn" onclick={() => onclose?.()}
                >Close</button
            >
        </div>
    </div>
</div>

<style>
    /* ── Backdrop ────────────────────────────────────────────────────────── */
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: 3000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        box-sizing: border-box;
    }

    /* ── Panel ───────────────────────────────────────────────────────────── */
    .panel {
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 8px;
        box-shadow:
            0 16px 48px rgba(0, 0, 0, 0.18),
            0 4px 12px rgba(0, 0, 0, 0.1);
        display: flex;
        flex-direction: column;
        width: min(940px, 100%);
        height: min(680px, 100%);
        overflow: hidden;
    }

    /* ── Header ──────────────────────────────────────────────────────────── */
    .panel-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        background: var(--color-surface, #fff);
        flex-shrink: 0;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 7px;
        flex-shrink: 0;
    }

    .header-fx {
        font-size: 11px;
        font-weight: 700;
        font-family: monospace;
        color: #64748b;
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        padding: 1px 5px;
        border-radius: 3px;
    }

    .header-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text, #1e293b);
        white-space: nowrap;
    }

    .header-search {
        flex: 1;
        position: relative;
        max-width: 320px;
    }

    .search-icon {
        position: absolute;
        left: 8px;
        top: 50%;
        transform: translateY(-50%);
        width: 13px;
        height: 13px;
        color: #94a3b8;
        pointer-events: none;
    }

    .search-input {
        width: 100%;
        height: 28px;
        padding: 0 8px 0 28px;
        font-size: 12px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 5px;
        background: var(--color-fill, #f8fafc);
        color: var(--color-text, #1e293b);
        outline: none;
        box-sizing: border-box;
    }

    .search-input:focus {
        border-color: #94a3b8;
        background: var(--color-surface, #fff);
    }

    .close-btn {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text-muted, #94a3b8);
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
    }

    .close-btn:hover {
        background: var(--color-fill, #f1f5f9);
        color: var(--color-text, #1e293b);
    }
    .close-btn svg {
        width: 11px;
        height: 11px;
    }

    /* ── Body ────────────────────────────────────────────────────────────── */
    .panel-body {
        display: flex;
        flex: 1;
        overflow: hidden;
    }

    /* ── Sidebar ─────────────────────────────────────────────────────────── */
    .sidebar {
        width: 176px;
        flex-shrink: 0;
        padding: 8px 0;
        border-right: 1px solid var(--color-border, #e2e8f0);
        background: var(--color-fill, #f8fafc);
        overflow-y: auto;
        display: flex;
        flex-direction: column;
    }

    .cat-btn {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 12px;
        border: none;
        background: transparent;
        cursor: pointer;
        text-align: left;
        gap: 6px;
        border-radius: 0;
    }

    .cat-btn:hover:not(:disabled) {
        background: var(--color-fill-secondary, #e2e8f0);
    }
    .cat-btn.active {
        background: var(--color-surface, #fff);
        border-left: 2px solid var(--color-primary, #3b82f6);
        padding-left: 10px;
    }
    .cat-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }

    .cat-label {
        font-size: 12px;
        color: var(--color-text, #1e293b);
        flex: 1;
    }

    .cat-btn.active .cat-label {
        font-weight: 600;
        color: var(--color-primary, #3b82f6);
    }

    .cat-count {
        font-size: 10px;
        color: #94a3b8;
        background: var(--color-fill, #f1f5f9);
        padding: 0 5px;
        border-radius: 8px;
        min-width: 18px;
        text-align: center;
        font-variant-numeric: tabular-nums;
    }

    .cat-btn.active .cat-count {
        background: #eff6ff;
        color: #3b82f6;
    }

    .sidebar-divider {
        height: 1px;
        background: var(--color-border, #e2e8f0);
        margin: 8px 0;
    }

    .sidebar-note {
        padding: 6px 12px;
        font-size: 10px;
        color: #94a3b8;
        line-height: 1.5;
    }

    .sidebar-note strong {
        color: #64748b;
        font-weight: 600;
    }
    .sidebar-note em {
        font-style: normal;
        color: #64748b;
    }
    .sidebar-note code {
        font-family: monospace;
        font-size: 9.5px;
        background: #e8f0fe;
        color: #1e40af;
        padding: 0 3px;
        border-radius: 2px;
    }

    /* ── Content ─────────────────────────────────────────────────────────── */
    .content {
        flex: 1;
        overflow-y: auto;
        padding: 6px 12px 12px;
    }

    .group-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: #64748b;
        padding: 10px 4px 4px;
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        margin-bottom: 4px;
        margin-top: 4px;
    }

    .group-count {
        font-size: 10px;
        color: #94a3b8;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
    }

    /* ── Function card ───────────────────────────────────────────────────── */
    .fn-card {
        padding: 8px 8px 9px;
        border-radius: 5px;
        margin-bottom: 3px;
        border: 1px solid transparent;
    }

    .fn-card:hover {
        background: var(--color-fill, #f8fafc);
        border-color: var(--color-border, #e2e8f0);
    }

    .fn-top {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 3px;
    }

    .fn-name {
        font-size: 12px;
        font-weight: 700;
        font-family: monospace;
        color: var(--color-text, #1e293b);
        flex-shrink: 0;
    }

    .fn-syntax {
        font-size: 11px;
        font-family: monospace;
        color: #3b82f6;
        background: #eff6ff;
        padding: 1px 6px;
        border-radius: 3px;
        white-space: pre-wrap;
        word-break: break-all;
    }

    .fn-desc {
        margin: 0 0 4px;
        font-size: 11.5px;
        color: var(--color-text-secondary, #475569);
        line-height: 1.5;
    }

    .fn-note {
        margin: 0 0 4px;
        font-size: 10.5px;
        color: #94a3b8;
        font-style: italic;
        line-height: 1.4;
    }

    .fn-example {
        margin: 0;
        font-family: monospace;
        font-size: 10.5px;
        color: #1e40af;
        background: #f0f4ff;
        border-left: 2px solid #bfdbfe;
        padding: 4px 8px;
        border-radius: 0 3px 3px 0;
        white-space: pre-wrap;
        line-height: 1.6;
    }

    /* ── Empty state ─────────────────────────────────────────────────────── */
    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 200px;
        gap: 8px;
        color: #94a3b8;
    }

    .empty-icon {
        font-size: 28px;
    }
    .empty-state p {
        font-size: 12px;
        margin: 0;
    }
    .empty-state strong {
        color: #64748b;
    }

    /* ── Footer ──────────────────────────────────────────────────────────── */
    .panel-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 7px 14px;
        border-top: 1px solid var(--color-border, #e2e8f0);
        background: var(--color-fill, #f8fafc);
        flex-shrink: 0;
        gap: 12px;
    }

    .footer-note {
        font-size: 10.5px;
        color: #94a3b8;
        flex: 1;
    }

    .footer-note code {
        font-family: monospace;
        font-size: 10px;
        background: #e2e8f0;
        color: #475569;
        padding: 0 4px;
        border-radius: 2px;
    }

    .footer-close-btn {
        height: 26px;
        padding: 0 14px;
        font-size: 12px;
        font-weight: 500;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        cursor: pointer;
        flex-shrink: 0;
    }

    .footer-close-btn:hover {
        background: var(--color-fill, #f1f5f9);
    }
</style>
