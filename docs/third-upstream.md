# Third upstream: a public MCP server we do not operate.
#
# The assignment requires three upstream MCP servers. Two run in this
# cluster (the WooCommerce server and the notes server). The third is an
# external, publicly reachable MCP server so the demo also proves the
# gateway can consume something it does not deploy.
#
# This file is documentation, not configuration. Register it at runtime
# through the dashboard (or the API) so its URL is reviewed rather than
# baked into the chart:
#
#   POST /api/servers
#   {
#     "slug": "weather",
#     "name": "Weather",
#     "baseUrl": "https://<chosen-public-mcp-server>/mcp",
#     "authType": "none"
#   }
#
# Suggested servers that speak Streamable HTTP and need no key:
#   - A public weather MCP server (search the MCP server registry for
#     "weather" and confirm it advertises the streamable-http transport).
#
# If no public server is reachable during the demo, fall back to running a
# second copy of the notes server under a different slug — the requirement
# is three upstreams, not three distinct codebases. Record the final choice
# in docs/INTERVIEW_PREP.md before the interview.
