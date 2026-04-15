'use strict';

/**
 * autoresearch_sensitive_domains.cjs — detect sensitive domains requiring
 * graduated approval, per AutoReason SPEC v2.
 *
 * We do NOT exclude sensitive domains from research (the spec explicitly
 * rejects exclusion zones). Instead, proposals touching these domains
 * route to a human-approval queue rather than auto-applying, and the
 * council is augmented with a security-specialist judge.
 *
 * Domains:
 *   crypto      — encryption, hashing, signing, JWT, token generation
 *   auth        — authentication, sessions, login, passwords, OAuth
 *   public_api  — externally-consumed API surfaces (breaking changes affect consumers)
 *   schemas     — database schemas, data models, contracts
 *   migrations  — schema migrations, data backfills, destructive transforms
 */

const { AdapterError } = require('./errors.cjs');

const SENSITIVE_DOMAIN_PATTERNS = Object.freeze({
  crypto: Object.freeze([
    /(?:^|[\/_\-\.])(crypto|encrypt|decrypt|cipher|hmac|hash|jwt|bcrypt|argon2|scrypt|pbkdf|nonce)(?:[\/_\-\.]|$)/i,
    /(?:^|[\/_\-\.])(sign|verify|secret)(?:[\/_\-\.]|$)(?![a-z])/i,
    /(?:^|[^A-Za-z0-9])(crypto|encrypt|decrypt|cipher|hmac|jwt|bcrypt|argon2|scrypt|pbkdf)(?:[^A-Za-z0-9]|$)/i,
  ]),
  auth: Object.freeze([
    /(?:^|[\/_\-\.])(auth|authn|authz|authorization|authentication|session|login|logout|password|oauth|passkey|webauthn|saml|sso|bearer)(?:[\/_\-\.]|$)/i,
    /(?:^|[^A-Za-z0-9])(authentication|authorization|oauth|passkey|webauthn|saml|sso|bearer)(?:[^A-Za-z0-9]|$)/i,
  ]),
  public_api: Object.freeze([
    /(^|[\/\.])(api|routes?|endpoints?|public|handlers?|controllers?)([\/\.]|$)/i,
    /(?:^|[\/_\-\.])(openapi|swagger|graphql|rpc|trpc)(?:[\/_\-\.]|$)/i,
  ]),
  schemas: Object.freeze([
    /(^|[\/\.])(schema|schemas|models?|entities|dto|contracts?)([\/\.]|$)/i,
    /\.sql$/i,
    /\.proto$/i,
    /json[-_ ]?schema/i,
  ]),
  migrations: Object.freeze([
    /(^|[\/\.])(migrations?|alembic|flyway|liquibase|knex)([\/\.]|$)/i,
    /(?:^|[\/_\-\.])(backfill|rollback|irreversible)(?:[\/_\-\.]|$)/i,
  ]),
});

const DOMAIN_APPROVAL_REQUIREMENTS = Object.freeze({
  crypto: Object.freeze({
    autoApply: false,
    requireHumanReview: true,
    requireSpecialistJudge: true,
    quarantineAnyNewDep: true,
  }),
  auth: Object.freeze({
    autoApply: false,
    requireHumanReview: true,
    requireSpecialistJudge: true,
    quarantineAnyNewDep: true,
  }),
  public_api: Object.freeze({
    autoApply: false,
    requireHumanReview: true,
    requireVersioningPlan: true,
  }),
  schemas: Object.freeze({
    autoApply: false,
    requireHumanReview: true,
    requireMigrationPlan: true,
  }),
  migrations: Object.freeze({
    autoApply: false,
    requireHumanReview: true,
    requireRollbackPlan: true,
    requireBackupVerified: true,
  }),
});

function normalizeInputPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new AdapterError(
      'SENSITIVE_DOMAIN_PATH_REQUIRED',
      'filePath',
      'detectSensitiveDomains requires a non-empty string filePath',
      { fixHint: 'Pass a relative or absolute file path as a string.' },
    );
  }
  return filePath.replace(/\\/g, '/');
}

function detectSensitiveDomains(filePath, content = '') {
  const normalizedPath = normalizeInputPath(filePath);
  const haystack = typeof content === 'string' && content.length > 0
    ? `${normalizedPath}\n${content.slice(0, 4000)}`
    : normalizedPath;
  const matched = [];
  for (const [domain, patterns] of Object.entries(SENSITIVE_DOMAIN_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(haystack)) {
        matched.push(domain);
        break;
      }
    }
  }
  return matched;
}

function isSensitive(filePath, content = '') {
  return detectSensitiveDomains(filePath, content).length > 0;
}

function approvalRequirementsFor(domains) {
  const input = Array.isArray(domains) ? domains : [domains];
  const merged = {
    autoApply: true,
    requireHumanReview: false,
    requireSpecialistJudge: false,
    quarantineAnyNewDep: false,
    requireVersioningPlan: false,
    requireMigrationPlan: false,
    requireRollbackPlan: false,
    requireBackupVerified: false,
  };
  for (const domain of input) {
    const reqs = DOMAIN_APPROVAL_REQUIREMENTS[domain];
    if (!reqs) {
      continue;
    }
    if (reqs.autoApply === false) {
      merged.autoApply = false;
    }
    for (const key of Object.keys(reqs)) {
      if (key === 'autoApply') {
        continue;
      }
      if (reqs[key] === true) {
        merged[key] = true;
      }
    }
  }
  return merged;
}

function extractTouchedFiles(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return [];
  }
  const changeSet = Array.isArray(proposal.changeSet) ? proposal.changeSet : [];
  const seen = new Set();
  const ordered = [];
  for (const change of changeSet) {
    if (!change || typeof change !== 'object') {
      continue;
    }
    const raw = typeof change.path === 'string' ? change.path : '';
    if (!raw) {
      continue;
    }
    const normalized = raw.replace(/\\/g, '/');
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function extractChangeContent(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return '';
  }
  const changeSet = Array.isArray(proposal.changeSet) ? proposal.changeSet : [];
  const parts = [];
  for (const change of changeSet) {
    if (!change || typeof change !== 'object') {
      continue;
    }
    for (const field of ['match', 'replace', 'anchor', 'text']) {
      const value = change[field];
      if (typeof value === 'string' && value.length > 0) {
        parts.push(value);
      }
    }
  }
  return parts.join('\n');
}

function buildApprovalTicket(proposal, options = {}) {
  if (!proposal || typeof proposal !== 'object') {
    throw new AdapterError(
      'SENSITIVE_DOMAIN_PROPOSAL_REQUIRED',
      'proposal',
      'buildApprovalTicket requires a proposal object',
      { fixHint: 'Pass the research proposal that should be routed to human approval.' },
    );
  }
  const touchedFiles = extractTouchedFiles(proposal);
  const declaredFiles = Array.isArray(proposal.targetFiles) ? proposal.targetFiles : [];
  const sharedContent = extractChangeContent(proposal);
  const perFileDomains = {};
  const allDomains = new Set();
  for (const filePath of touchedFiles) {
    const domains = detectSensitiveDomains(filePath, sharedContent);
    if (domains.length > 0) {
      perFileDomains[filePath] = domains;
      domains.forEach((d) => allDomains.add(d));
    }
  }
  const declaredOnly = declaredFiles
    .map((entry) => (typeof entry === 'string' ? entry.replace(/\\/g, '/') : ''))
    .filter((entry) => entry && !touchedFiles.includes(entry));
  const sortedDomains = Array.from(allDomains).sort();
  return {
    proposalId: proposal.hypothesisId || null,
    touchedFiles,
    declaredFiles,
    declaredButNotTouched: declaredOnly,
    sensitiveDomains: sortedDomains,
    perFileDomains,
    requirements: approvalRequirementsFor(sortedDomains),
    requiresApproval: sortedDomains.length > 0,
    requestedAt: options.requestedAt || new Date().toISOString(),
    requestedBy: options.requestedBy || 'autoresearch',
  };
}

module.exports = {
  DOMAIN_APPROVAL_REQUIREMENTS,
  SENSITIVE_DOMAIN_PATTERNS,
  approvalRequirementsFor,
  buildApprovalTicket,
  detectSensitiveDomains,
  extractChangeContent,
  extractTouchedFiles,
  isSensitive,
};
