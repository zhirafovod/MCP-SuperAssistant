# Dockerfile

# 1. Use Node 18 LTS (alpine for Web Streams support)
FROM node:20-alpine

# a requirement for desktop-commander
RUN apk add --no-cache bash

# 2. Set the working directory
WORKDIR /workspace

# 3. Copy your msconfig.yaml into the container
COPY mcpconfig.yaml /mcpconfig.json

# 4. Install the MCP SuperAssistant proxy globally
RUN npm install -g @srbhptl39/mcp-superassistant-proxy@latest tsx express cors body-parser

# Copy API server
COPY packages/api-server /api-server

# 5. Expose the SSE port
EXPOSE 3000
EXPOSE 3006
EXPOSE 3007

# 6. ENTRYPOINT wrapper:
#    - $1 is the workspace path (default /workspace)
#    - shift off that arg, then exec the proxy binary pointing at $WORKDIR/mcpconfig.json
ENTRYPOINT ["sh","-c", "\
  WORKDIR=\"${1:-/workspace}\"; \
  shift; \
  tsx /api-server/index.mts & \
  exec mcp-superassistant-proxy --config \"/mcpconfig.json\" \"$@\"\
","-"]
