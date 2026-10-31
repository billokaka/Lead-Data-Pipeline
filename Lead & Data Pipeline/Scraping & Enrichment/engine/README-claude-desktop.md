# Using the enrichment engine from Claude Desktop

Claude Code picks the engine up from the workspace's `.mcp.json`. For **Claude Desktop**, go to
Settings → Developer → Edit Config and add this inside `"mcpServers"`, with your own paths:

```json
"enrichment": {
  "command": "node",
  "args": ["D:/With_Abdullah/ryan-outbound/Project/Lead & Data Pipeline/Scraping & Enrichment/engine/src/mcp.mjs"],
  "env": { "ENRICH_ENV_FILE": "D:/With_Abdullah/ryan-outbound/.env" }
}
```

Then restart Claude Desktop. The keys come from the `.env` named there, never from this file.
Each person's `.env` has their own `ENRICH_PERSON`.

**When Claude Desktop asks permission:**
- For **Confirm** and **Approve or reject owners**, choose **Allow once** every time, never
  "Always allow". Those two start spending.
- **Run the engine** and **Pause every engine** spend nothing themselves. Allowing them is your
  choice.

Node.js 20 or newer must be installed, and `npm install` run once in this folder. A one-file
Claude Desktop extension (`.mcpb`, like the Smartlead one) can be built once the engine has had
its first live run.
