# Live reproduction is not an MCP capability

Crumbtrail MCP is a read only context retrieval surface. It does not expose an
`allowReproduction` option, drive a browser, navigate a live application, or
record a new session. `solveContext` only analyzes supplied symptoms and
retrieved context.

Any future live reproduction capability requires a separate product and safety
review. It must not be enabled through the MCP bug context interface.
