# Nora MCP Configuration

Nora reads MCP configuration from the active workspace's `.vscode/mcp.json`.
The file is JSONC and may contain only `servers` and `inputs`.

Nora supports stdio and Streamable HTTP MCP servers. It does not import MCP
configuration from Pi, Codex, Claude, or other host-specific files.

## Example

```jsonc
{
  "inputs": [
    {
      "id": "confluence-token",
      "type": "promptString",
      "description": "Confluence MCP token",
      "password": true
    },
    {
      "id": "region",
      "type": "pickString",
      "description": "MCP region",
      "options": [
        { "label": "US", "value": "us" },
        { "label": "EU", "value": "eu" }
      ]
    }
  ],
  "servers": {
    "confluence": {
      "type": "http",
      "url": "https://mcp.example.test/${input:region}/mcp",
      "headers": {
        "Authorization": "Bearer ${input:confluence-token}"
      }
    },
    "workspace-docs": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/tools/docs-mcp.js"],
      "cwd": "${workspaceFolder}",
      "envFile": "${workspaceFolder}/.env",
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

## Supported Server Fields

Stdio server:

- `type`: `stdio`.
- `command`: executable command.
- `args`: string array.
- `cwd`: optional working directory.
- `env`: optional string map.
- `envFile`: optional dotenv file path.

HTTP server:

- `type`: `http`.
- `url`: HTTP or HTTPS URL.
- `headers`: optional string map.

Server names must not contain slashes or control characters. HTTP URLs must not
contain URL userinfo or credential-bearing query parameters.

## Supported Inputs

Inputs are resolved only when a server connection needs them.

`promptString`:

- `id`
- `type`
- `description`
- `default`
- `password`

`pickString`:

- `id`
- `type`
- `description`
- `options`
- `default`

`command`:

- `id`
- `type`
- `command`
- `args`

`command` inputs call `vscode.commands.executeCommand` and must return a string.
Resolved input values are cached only in the live connection and are discarded on
disconnect.

## Variables

Nora resolves these variables in supported string fields:

- `${workspaceFolder}`
- `${workspaceFolderBasename}`
- `${userHome}`
- `${env:NAME}`
- `${input:id}`

Unresolved variables, unknown input IDs, empty environment references, and
unsupported variable names are errors.

`envFile` values are parsed with dotenv. Explicit `env` entries override values
from the env file.

## Rejected Fields and Transports

Nora rejects:

- Legacy SSE transport.
- OAuth automation fields.
- Sandbox fields.
- Development-server fields.
- Prompt/import fields.
- Approval or policy fields.
- Unsupported top-level fields.
- Unsupported server fields.

Authentication remains possible through configured headers, environment values,
dotenv files, and inputs. Nora does not store those values.

## Lifecycle

Connections are shared by workspace folder, server name, and normalized
non-secret configuration fingerprint. A server starts lazily on the first actual
tool or resource request. Multiple open `.nora` documents reuse the same
connection when the configuration matches.

When `.vscode/mcp.json` changes, Nora lets in-flight calls finish and recreates
the connection on the next call. Stdio child processes are shut down when the
last reference releases.

Calls have a two-minute timeout, cancellation propagation, and bounded reconnect
attempts. Tool/resource list changes are refreshed when the server notifies
Nora.

## Pi Tool Bridge

Nora exposes MCP to Pi through one compact `mcp` tool with operations for:

- `search`
- `describe`
- `call`
- `list_resources`
- `read_resource`

Frequently used tools may be exposed as direct Pi tools by listing exact
`server/tool` names in `nora.mcp.directTools`. Direct tool names are generated as
`mcp__<sanitized-server>__<sanitized-tool>`, while transcripts retain the
original server/tool names in metadata.

## Output Bounds and Persistence

Each model-facing MCP result is bounded to 256 KiB UTF-8 and 2,000 text lines.
When truncation happens, Nora includes an explicit truncation record. The
transcript stores exactly the bounded result that Pi saw.

When an MCP resource returns a binary blob, Nora decodes, hashes, and stores the
raw bytes as a normal content-addressed attachment before the document mutation
commits. Pi and the transcript receive only the bounded attachment and evidence
metadata, not an inline base64 blob.

Nora OutputChannel diagnostics include only server ID, operation, status,
duration, and bounded error class. Diagnostics do not include URLs, headers,
environment values, resolved inputs, tool arguments, tool results, or
credentials.

## Security Boundary

Nora faithfully connects to user-selected servers. It does not claim their tools
are safe, read-only, authenticated, or side-effect free.

Users are responsible for:

- Which servers are configured.
- Which credentials and headers are supplied.
- Which skills can call MCP tools.
- Whether returned tool/resource data is appropriate to persist.

Nora stores no MCP secret in SecretStorage or `.nora`, but MCP results shown to
Pi are research history and are persisted losslessly after output bounding.
