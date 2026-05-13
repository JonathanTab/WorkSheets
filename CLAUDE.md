## Cheap-Worker Delegation Tools (Token Saving)

Three CLI tools delegate bulk I/O to a cheap worker model. Use them to save tokens. Run them with powershell.

### ask-kimi — bulk reading
For reading files >400 lines, or when you'd otherwise read 3+ files:

```powershell
$env:PYTHONIOENCODING = \"utf-8\"; C:\\Users\\Jon\\.local\\bin\\ask-kimi.bat --paths <file1> <file2>... --question "<specific question>"
```

Use this to gain an understanding of relevant files while doing research or exploring. make it read all the possible  relevant files and ask it to summarize the structure, purpose, or operation file with line numbers according to the topic you are exploring. Use it instead of reading files yourself.
Only read files directly when you need to make edits to specific lines.

### kimi-write — boilerplate generation
For generating tests, config files, docstrings, or repetitive code patterns:

```powershell
$env:PYTHONIOENCODING = \"utf-8\"; C:\\Users\\Jon\\.local\\bin\\kimi-write.bat --spec "<what to write>" --context <existing-similar-file> --target <output-path>
```

Then review the output and edit only what needs fixing.

### extract-chat — chat transcript extraction
Extracts human-readable text from Claude Code JSONL transcripts:

```powershell
$env:PYTHONIOENCODING = \"utf-8\"; C:\\Users\\Jon\\.local\\bin\\extract-chat.bat <session.jsonl> -o /tmp/chat.txt
```

### Documentation workflow (MANDATORY)
**NEVER write documentation directly. Always delegate:**

1. Extract chat: `extract-chat <latest-session.jsonl> -o /tmp/chat.txt`
2. Ask worker to read chat + existing docs and suggest updates:
   `ask-kimi --paths /tmp/chat.txt <doc-files> --question "read chat, give exact changes for docs"`
3. Apply the worker's changes via Edit tool

### When NOT to delegate
- Tasks under ~2000 tokens of work (delegation overhead isn't worth it)
- Architectural decisions, debugging, safety-critical code
- Anything requiring careful reasoning
- When exact line numbers are needed for editing
