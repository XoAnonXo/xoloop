'use strict';

const { runCliCommand } = require('./goal_cli_runner.cjs');

function includesAll(text, needles) {
  return needles.every((needle) => String(text).includes(needle));
}

function buildFailure(command, result, checks) {
  const failedCheck = checks.find((check) => !check.pass);
  return {
    case_id: command.id,
    obligation: command.id,
    message: failedCheck ? failedCheck.message : `command ${command.id} failed`,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout_tail: String(result.stdout || '').slice(-2000),
    stderr_tail: String(result.stderr || '').slice(-2000),
  };
}

async function runCommandSuiteVerification(goal, _goalPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const commands = Array.isArray(goal.verify && goal.verify.commands) ? goal.verify.commands : [];
  const verifications = [];
  const metrics = {
    wall_time_ms: 0,
    peak_memory_mb: 0,
  };
  let counterexample = null;

  for (const command of commands) {
    const result = await runCliCommand(command.command, '', {
      cwd,
      timeoutMs: command.timeout_ms,
    });
    metrics.wall_time_ms += result.metrics.wall_time_ms || 0;
    metrics.peak_memory_mb = Math.max(metrics.peak_memory_mb, result.metrics.peak_memory_mb || 0);

    const checks = [
      {
        pass: result.exitCode === command.expect_exit_code,
        message: `expected exit ${command.expect_exit_code}, got ${result.exitCode}`,
      },
      {
        pass: !result.timedOut,
        message: `command timed out after ${command.timeout_ms}ms`,
      },
      {
        pass: includesAll(result.stdout, command.expect_stdout_includes || []),
        message: `stdout did not include all expected strings: ${(command.expect_stdout_includes || []).join(', ')}`,
      },
      {
        pass: includesAll(result.stderr, command.expect_stderr_includes || []),
        message: `stderr did not include all expected strings: ${(command.expect_stderr_includes || []).join(', ')}`,
      },
    ];
    const passed = checks.every((check) => check.pass);
    verifications.push({
      id: command.id,
      status: passed ? 'pass' : 'fail',
      case_id: command.id,
      command: command.command,
      exit_code: result.exitCode,
      wall_time_ms: result.metrics.wall_time_ms,
      peak_memory_mb: result.metrics.peak_memory_mb,
    });
    if (!passed && !counterexample) counterexample = buildFailure(command, result, checks);
  }

  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics,
    counterexample,
  };
}

module.exports = {
  runCommandSuiteVerification,
};
