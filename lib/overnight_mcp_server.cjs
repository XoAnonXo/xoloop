const path = require('node:path');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { AdapterError } = require('./errors.cjs');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const {
  cleanupOvernightBatch,
  initOvernightEngine,
  inspectOvernightBatch,
  promoteOvernightBatch,
  resolveDeferredAudit,
  runOvernightBatch,
  validateOvernightAdapter,
} = require('./overnight_engine.cjs');
const { runHostileRepoMatrix } = require('./hostile_repo_matrix.cjs');

function asToolResult(payload) {
  let serialized;
  try {
    serialized = JSON.stringify(payload ?? null, null, 2);
  } catch (err) {
    throw new AdapterError('TOOL_RESULT_SERIALIZATION_FAILED', 'payload', 'MCP tool result payload is not JSON-serializable', { fixHint: 'Return a plain JSON-serializable object from the tool handler; strip circular references, BigInt values, or functions before returning.', cause: err });
  }
  return {
    content: [
      {
        type: 'text',
        text: serialized,
      },
    ],
  };
}

function buildSyntheticAuditDecision(verdict) {
  const normalized = String(verdict || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!['accept', 'reject'].includes(normalized)) {
    throw new AdapterError('INVALID_SYNTHETIC_AUDIT', 'syntheticAudit', 'syntheticAudit must be accept or reject', { fixHint: 'Set syntheticAudit to one of: accept, reject.' });
  }
  return {
    verdict: normalized,
    confidence: 1,
    blockers: normalized === 'reject' ? ['Synthetic audit rejected this attempt.'] : [],
    evidence: [`Synthetic audit ${normalized === 'reject' ? 'rejected' : 'accepted'} this attempt.`],
  };
}

function buildOvernightMcpServer() {
  const server = new McpServer({
    name: 'xoanonxoloop',
    version: '0.2.0',
  });

  server.tool(
    'init_engine',
    'Generate starter overnight.yaml and objective.yaml for a target repo.',
    {
      cwd: z.string().optional(),
      adapterPath: z.string().optional(),
      objectivePath: z.string().optional(),
      force: z.boolean().optional(),
    },
    async ({ cwd, adapterPath, objectivePath, force }) => asToolResult(await initOvernightEngine({
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      adapterPath,
      objectivePath,
      force,
    })),
  );

  server.tool(
    'validate_adapter',
    'Validate the overnight adapter and objective contract for a target repo.',
    {
      cwd: z.string().optional(),
      adapterPath: z.string().optional(),
      objectivePath: z.string().optional(),
    },
    async ({ cwd, adapterPath, objectivePath }) => asToolResult(validateOvernightAdapter({
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      adapterPath,
      objectivePath,
    })),
  );

  server.tool(
    'run_batch',
    'Run the overnight engine for a target repo.',
    {
      cwd: z.string().optional(),
      adapterPath: z.string().optional(),
      objectivePath: z.string().optional(),
      batchId: z.string().optional(),
      attemptLimit: z.number().int().positive().optional(),
      maxTotalAttempts: z.number().int().positive().optional(),
      proposalMode: z.enum(['legacy', 'staged']).optional(),
      allowDirty: z.boolean().optional(),
      syntheticAudit: z.enum(['accept', 'reject']).optional(),
    },
    async ({ cwd, adapterPath, objectivePath, batchId, attemptLimit, maxTotalAttempts, proposalMode, allowDirty, syntheticAudit }) => {
      const payload = await runOvernightBatch({
        cwd: cwd ? path.resolve(cwd) : process.cwd(),
        adapterPath,
        objectivePath,
        batchId,
        attemptLimit,
        maxTotalAttempts,
        proposalMode,
        allowDirty,
        syntheticAuditDecision: buildSyntheticAuditDecision(syntheticAudit),
      });
      return asToolResult(payload);
    },
  );

  server.tool(
    'inspect_batch',
    'Inspect a finished overnight batch.',
    {
      batchDir: z.string(),
    },
    async ({ batchDir }) => asToolResult(inspectOvernightBatch({
      batchDir: path.resolve(batchDir),
    })),
  );

  server.tool(
    'promote_batch',
    'Promote kept overnight commits into one integration branch.',
    {
      batchDir: z.string(),
    },
    async ({ batchDir }) => asToolResult(await promoteOvernightBatch({
      batchDir: path.resolve(batchDir),
    })),
  );

  server.tool(
    'cleanup_batch',
    'Remove overnight worktrees for a finished batch.',
    {
      batchDir: z.string(),
    },
    async ({ batchDir }) => asToolResult(await cleanupOvernightBatch({
      batchDir: path.resolve(batchDir),
    })),
  );

  server.tool(
    'resolve_audit',
    'Resolve a deferred overnight audit decision.',
    {
      batchDir: z.string(),
      surfaceId: z.string(),
      attemptId: z.string().optional(),
      verdict: z.enum(['accept', 'reject']),
      note: z.string().optional(),
    },
    async ({ batchDir, surfaceId, attemptId, verdict, note }) => asToolResult(await resolveDeferredAudit({
      batchDir: path.resolve(batchDir),
      surfaceId,
      attemptId,
      verdict,
      note,
    })),
  );

  server.tool(
    'run_hostile_matrix',
    'Run the hostile repo fixture matrix across Node, Python, Go, and Rust-shaped repos.',
    {
      stacks: z.array(z.string()).optional(),
    },
    async ({ stacks }) => asToolResult(await runHostileRepoMatrix({
      stacks,
    })),
  );

  return server;
}

async function runOvernightMcpServer() {
  const server = buildOvernightMcpServer();
  if (!server || typeof server.connect !== 'function') {
    throw new AdapterError('MCP_SERVER_BOOT_FAILED', 'server', 'buildOvernightMcpServer did not return a connectable MCP server', { fixHint: 'Ensure @modelcontextprotocol/sdk is installed and McpServer returns an object exposing a connect(transport) method.' });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = {
  buildOvernightMcpServer,
  buildSyntheticAuditDecision,
  runOvernightMcpServer,
};
