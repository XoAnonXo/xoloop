const fs = require('node:fs');
const path = require('node:path');

const YAML = require('yaml');

const { AdapterError } = require('./errors.cjs');

function readYamlFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  const document = YAML.parse(text);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new AdapterError('YAML_NOT_OBJECT', 'yamlPath', `YAML document must be an object: ${absolutePath}`, { fixHint: `Rewrite ${absolutePath} so its top-level is a mapping (key/value object), not a scalar, list, or null.` });
  }
  return {
    absolutePath,
    text,
    document,
  };
}

function writeYamlFile(filePath, payload) {
  const absolutePath = path.resolve(filePath);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdapterError('YAML_PAYLOAD_NOT_OBJECT', 'payload', `YAML payload must be a plain object: ${absolutePath}`, { fixHint: `Pass a key/value object (not null, an array, or a scalar) to writeYamlFile when writing ${absolutePath}.` });
  }
  const text = YAML.stringify(payload, {
    lineWidth: 0,
    minContentWidth: 0,
  });
  fs.writeFileSync(absolutePath, text, 'utf8');
  return absolutePath;
}

module.exports = {
  readYamlFile,
  writeYamlFile,
};
